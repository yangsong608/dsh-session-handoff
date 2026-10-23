import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// src/host/config.ts
const DEFAULTS = {
	enabled: true,
	dir: ".dsh-handoff",
	memoryFile: "交接记忆.md",
	writeMemory: true,
	provider: "",
	model: "",
	maxTokens: 8192,
	maxInputChars: 8e4,
	maxToolCalls: 400,
	promptCharBudget: 6e3,
	autoSend: false,
	preview: true,
	timeoutMs: 18e4,
	maxBodyBytes: 262144
};
function bool(value, fallback, warnings, key) {
	if (value === void 0) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`${key}: 需要 boolean，已回退`);
	return fallback;
}
function text(value, fallback, warnings, key) {
	if (value === void 0) return fallback;
	if (typeof value === "string") return value;
	warnings.push(`${key}: 需要 string，已回退`);
	return fallback;
}
function int(value, fallback, min, max, warnings, key) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		warnings.push(`${key}: 需要数字，已回退`);
		return fallback;
	}
	const rounded = Math.trunc(value);
	if (rounded < min || rounded > max) {
		warnings.push(`${key}: 越界，已夹取到 ${min}..${max}`);
		return Math.min(max, Math.max(min, rounded));
	}
	return rounded;
}
/** 目录必须是相对路径且不含 `..`，否则回退默认值。 */
function relativeDir(value, fallback, warnings, key) {
	const raw = text(value, fallback, warnings, key).trim();
	const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
		if (raw !== fallback) warnings.push(`${key}: 只接受不含 .. 的相对目录，已回退 ${fallback}`);
		return fallback;
	}
	return normalized;
}
/** 只接受纯文件名（不含路径分隔符/越界段），否则回退。 */
function fileName(value, fallback, warnings, key) {
	const raw = text(value, fallback, warnings, key).trim();
	if (raw === "") return fallback;
	if (raw.length > 80 || raw === "." || raw === ".." || raw.includes("/") || raw.includes("\\")) {
		warnings.push(`${key}: 只接受纯文件名（不含路径分隔符），已回退 ${fallback}`);
		return fallback;
	}
	return raw;
}
/** 校验任意原始配置并返回规范化结果与告警。 */
function readConfig(raw) {
	const warnings = [];
	const source = raw !== null && typeof raw === "object" ? raw : {};
	return {
		config: {
			enabled: bool(source["enabled"], DEFAULTS.enabled, warnings, "enabled"),
			dir: relativeDir(source["dir"], DEFAULTS.dir, warnings, "dir"),
			memoryFile: fileName(source["memoryFile"], DEFAULTS.memoryFile, warnings, "memoryFile"),
			writeMemory: bool(source["writeMemory"], DEFAULTS.writeMemory, warnings, "writeMemory"),
			provider: text(source["provider"], DEFAULTS.provider, warnings, "provider").trim(),
			model: text(source["model"], DEFAULTS.model, warnings, "model").trim(),
			maxTokens: int(source["maxTokens"], DEFAULTS.maxTokens, 256, 32768, warnings, "maxTokens"),
			maxInputChars: int(source["maxInputChars"], DEFAULTS.maxInputChars, 4e3, 4e5, warnings, "maxInputChars"),
			maxToolCalls: int(source["maxToolCalls"], DEFAULTS.maxToolCalls, 20, 2e3, warnings, "maxToolCalls"),
			promptCharBudget: int(source["promptCharBudget"], DEFAULTS.promptCharBudget, 1e3, 2e4, warnings, "promptCharBudget"),
			autoSend: bool(source["autoSend"], DEFAULTS.autoSend, warnings, "autoSend"),
			preview: bool(source["preview"], DEFAULTS.preview, warnings, "preview"),
			timeoutMs: int(source["timeoutMs"], DEFAULTS.timeoutMs, 5e3, 9e5, warnings, "timeoutMs"),
			maxBodyBytes: int(source["maxBodyBytes"], DEFAULTS.maxBodyBytes, 1024, 4194304, warnings, "maxBodyBytes")
		},
		warnings
	};
}
// src/host/collect.ts
const COLLECT_LIMITS = {
	maxToolCalls: 400,
	maxUserMessages: 80,
	maxAssistantTexts: 120,
	excerptChars: 2e3
};
/** 内容块数组或字符串 → 纯文本。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	return parts.join("\n").trim();
}
/** 截断并统一空白，用于模型输入与文档引用。 */
function excerpt(value, max) {
	const trimmed = (typeof value === "string" ? value : "").trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}\n…（已截断 ${trimmed.length - max} 字）`;
}
function record$1(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
const FILE_KEY = /(^|_)(path|file|filepath|file_path|notebook_path|target|filename)(_|$)/i;
const COMMAND_KEY = /(^|_)(command|cmd|script|shell)(_|$)/i;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
/** 从工具参数里识别文件路径与命令（尽力而为，未知工具名不影响结果）。 */
function pathsFromArguments(name, raw) {
	const files = [];
	const commands = [];
	const push = (list, value) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		if (trimmed === "" || trimmed.length > 1024) return;
		list.push(trimmed);
	};
	for (const match of raw.matchAll(PATCH_FILE)) push(files, match[1]);
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		if (/bash|shell|terminal|exec|run/i.test(name)) push(commands, raw);
		return {
			files,
			commands
		};
	}
	const walk = (value, depth) => {
		if (depth > 4 || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		const object = record$1(value);
		if (object === void 0) return;
		for (const [key, member] of Object.entries(object)) if (typeof member === "string") {
			if (FILE_KEY.test(key)) push(files, member);
			else if (COMMAND_KEY.test(key)) push(commands, member);
		} else walk(member, depth + 1);
	};
	walk(parsed, 0);
	if (commands.length === 0 && files.length === 0 && /bash|shell|terminal|exec/i.test(name)) push(commands, raw);
	return {
		files,
		commands
	};
}
function uniq(values, limit) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const value of values) {
		if (value === "") continue;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
		if (out.length >= limit) break;
	}
	return out;
}
function eventData(event, key) {
	return record$1(event.data)?.[key];
}
/** 把一份日志观测采集为事实集。 */
function collectFacts(snapshot, limits = COLLECT_LIMITS) {
	const degraded = [];
	const header = snapshot.session ?? { id: "" };
	const facts = {
		sessionId: String(header.id ?? ""),
		title: String(header.title ?? "").trim(),
		cwd: String(header.cwd ?? "").trim(),
		createdAt: Number(header.createdAt ?? 0) || 0,
		capturedAt: Date.now(),
		eventCount: 0,
		userMessages: [],
		injectedMessages: [],
		assistantTexts: [],
		tools: [],
		files: [],
		commands: [],
		failures: [],
		compactionSummaries: [],
		degraded
	};
	const events = Array.isArray(snapshot.events) ? snapshot.events : [];
	facts.eventCount = events.length;
	const callIndex = /* @__PURE__ */ new Map();
	const files = [];
	const commands = [];
	let titleFromEvent = "";
	const userMessages = [];
	const injected = [];
	const assistants = [];
	const failures = [];
	const compaction = [];
	const tools = [];
	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		switch (event.type) {
			case "user/message": {
				const text = contentText(eventData(event, "content"));
				if (text === "") break;
				const source = record$1(eventData(event, "source"));
				if (source !== void 0 && source["kind"] === "user") userMessages.push(excerpt(text, limits.excerptChars));
				else injected.push(excerpt(text, 600));
				break;
			}
			case "assistant/message": {
				const text = contentText(record$1(eventData(event, "message"))?.["content"]);
				if (text !== "") assistants.push(excerpt(text, Math.max(1200, Math.floor(limits.excerptChars))));
				break;
			}
			case "tool/call": {
				const name = String(eventData(event, "name") ?? "");
				const callId = String(eventData(event, "callId") ?? "");
				const raw = String(eventData(event, "arguments") ?? "");
				const extracted = pathsFromArguments(name, raw);
				for (const file of extracted.files) files.push(file);
				for (const command of extracted.commands) commands.push(command);
				const fact = {
					seq: event.seq,
					name,
					callId,
					argumentsExcerpt: excerpt(raw, 600),
					files: extracted.files,
					commands: extracted.commands,
					failed: false,
					resultExcerpt: ""
				};
				tools.push(fact);
				if (callId !== "") callIndex.set(callId, fact);
				break;
			}
			case "tool/result": {
				const message = record$1(eventData(event, "message"));
				const callId = String(message?.["toolCallId"] ?? "");
				const fact = callIndex.get(callId);
				const failed = message?.["isError"] === true;
				const text = contentText(message?.["content"]);
				if (fact !== void 0) {
					fact.failed = failed;
					fact.resultExcerpt = excerpt(text, 600);
				}
				if (failed) failures.push(excerpt(`${fact?.name ?? "tool"} 失败：${text}`, 600));
				break;
			}
			case "session/title": {
				const title = String(eventData(event, "title") ?? "").trim();
				if (title !== "") titleFromEvent = title;
				break;
			}
			case "compaction/summary": {
				const text = contentText(eventData(event, "summary"));
				if (text !== "") compaction.push(excerpt(text, 3e3));
				break;
			}
			case "request/header": {
				const config = record$1(record$1(eventData(event, "header"))?.["config"]);
				const provider = typeof config?.["provider"] === "string" ? config["provider"] : "";
				const model = typeof config?.["model"] === "string" ? config["model"] : "";
				if (provider !== "" && model !== "") facts.lastRoute = {
					provider,
					model
				};
				break;
			}
		}
	}
	if (titleFromEvent !== "") facts.title = titleFromEvent;
	facts.userMessages = userMessages.slice(-limits.maxUserMessages);
	facts.injectedMessages = injected.slice(-limits.maxAssistantTexts);
	facts.assistantTexts = assistants.slice(-limits.maxAssistantTexts);
	facts.tools = tools.slice(-limits.maxToolCalls);
	facts.failures = uniq(failures, 20);
	facts.compactionSummaries = compaction.slice(-3);
	facts.files = uniq(files, 200);
	facts.commands = uniq(commands, 120);
	if (facts.eventCount === 0) degraded.push("empty-log");
	if (facts.assistantTexts.length === 0 && facts.tools.length === 0) degraded.push("no-work-signal");
	if (facts.title === "") degraded.push("no-title");
	if (facts.cwd === "") degraded.push("no-cwd");
	return facts;
}
// src/host/files.ts
/**
* 落盘与路径安全：所有写入都限制在会话 cwd 之下，且拒绝覆盖既有文档。
*
* 写入使用「同目录临时文件 + rename」，失败不留半截文件；记忆台账先读后合并，
* 并在超过上限时滚动到 .1 备份，不静默丢弃历史。
*
* @module dsh-session-handoff/host/files
*/
/** 单次交接目录名的安全化：保留中英文、数字与连字符。 */
function slug(text, fallback = "session") {
	const cleaned = text.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	return cleaned !== "" ? cleaned : fallback;
}
/** 时间戳目录名：20261023-031500。 */
function stamp(time) {
	const date = new Date(time);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/**
* 解析 base 之下的相对路径，拒绝绝对路径、`..` 与指向 base 外的符号链接结果。
* @throws 当路径越界或 base 为空。
*/
function resolveInside(base, relativePath) {
	if (base === "" || !isAbsolute(base)) throw new Error(`工作目录必须是绝对路径：${base === "" ? "(空)" : base}`);
	if (isAbsolute(relativePath)) throw new Error(`拒绝绝对路径：${relativePath}`);
	const root = resolve(base);
	const target = resolve(root, relativePath);
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`路径越界：${relativePath}`);
	return target;
}
/** 原子写：先写临时文件再 rename（同目录保证同文件系统）。 */
async function writeAtomic(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, content, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, path);
}
/** 读取文本；不存在返回空串，其他错误抛出。 */
async function readTextIfExists(path) {
	try {
		return await readFile(path, "utf8");
	} catch (cause) {
		if (cause.code === "ENOENT") return "";
		throw cause;
	}
}
/** 文件是否存在。 */
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
/** 在既有文件后追加内容；超过上限时先把旧文件滚动为 .1。 */
async function appendWithRoll(path, header, block, limitBytes) {
	const existing = await readTextIfExists(path);
	const next = `${existing === "" ? header : existing}${block}`;
	if (Buffer.byteLength(next, "utf8") > limitBytes && existing !== "") {
		await writeAtomic(`${path}.1`, existing);
		await writeAtomic(path, `${header}${block}`);
		return;
	}
	await writeAtomic(path, next);
}
/** 为一次交接创建独占目录（存在则加序号，绝不覆盖）。 */
async function createRunDir(root, name) {
	await mkdir(root, { recursive: true });
	for (let index = 1; index <= 50; index += 1) {
		const candidate = join(root, index === 1 ? name : `${name}-${index}`);
		try {
			await mkdir(candidate, { recursive: false });
			return candidate;
		} catch (cause) {
			if (cause.code !== "EEXIST") throw cause;
		}
	}
	throw new Error(`无法创建交接目录：${join(root, name)}`);
}
/**
* 过滤参考文件：绝对路径必须存在，工作区内优先，其次相对路径，最后外部绝对路径。
* 目的是避免把 /tmp 临时截图或历史错误里的畸形路径带进交接文档与新会话提示词。
*/
async function filterReferences(base, files, limit = 40) {
	const seen = /* @__PURE__ */ new Set();
	const inside = [];
	const relativeFiles = [];
	const outside = [];
	const root = base === "" ? "" : resolve(base);
	for (const raw of files) {
		const file = String(raw ?? "").trim();
		if (file === "" || seen.has(file)) continue;
		seen.add(file);
		if (!isAbsolute(file)) {
			relativeFiles.push(file);
			continue;
		}
		let normalized;
		try {
			normalized = resolve(file);
		} catch {
			continue;
		}
		if (!await exists(normalized)) continue;
		const rel = root === "" ? ".." : relative(root, normalized);
		if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) inside.push(normalized);
		else outside.push(normalized);
	}
	return [
		...inside,
		...relativeFiles,
		...outside
	].slice(0, limit);
}
// src/host/render.ts
function iso(time) {
	return new Date(time).toISOString();
}
function oneLine(text) {
	return text.replace(/\s*\n\s*/g, " ").trim();
}
function fenceSafe(text) {
	return text.replace(/```/g, "``​`");
}
/** 交接文档（Markdown，可被任意编辑器/新会话直接阅读）。 */
function renderMarkdown(facts, data, meta) {
	const lines = [];
	lines.push("---");
	lines.push(`session: ${JSON.stringify(facts.sessionId)}`);
	lines.push(`title: ${JSON.stringify(data.title)}`);
	lines.push(`cwd: ${JSON.stringify(facts.cwd)}`);
	lines.push(`session_created: ${iso(facts.createdAt || facts.capturedAt)}`);
	lines.push(`handoff_created: ${iso(facts.capturedAt)}`);
	lines.push(`model: ${JSON.stringify(meta.model ?? (facts.lastRoute !== void 0 ? `${facts.lastRoute.provider}/${facts.lastRoute.model}` : "unknown"))}`);
	lines.push(`generated_by: ${meta.llm ? "dsh-session-handoff/llm" : "dsh-session-handoff/deterministic"}`);
	lines.push(`events: ${facts.eventCount}`);
	lines.push(`tool_calls: ${facts.tools.length}`);
	if (meta.degraded.length > 0) lines.push(`degraded: ${JSON.stringify(meta.degraded)}`);
	lines.push("---");
	lines.push("");
	lines.push(`# 会话交接：${data.title}`);
	lines.push("");
	if (data.summary !== "") {
		lines.push(`> ${oneLine(data.summary)}`);
		lines.push("");
	}
	lines.push("## 目标与意图");
	lines.push("");
	lines.push(data.goal !== "" ? data.goal : "（未记录到明确的用户目标）");
	lines.push("");
	lines.push("## 已完成");
	lines.push("");
	if (data.completed.length === 0) lines.push("- （没有可确认的完成项）");
	else for (const item of data.completed) lines.push(`- ${item}`);
	lines.push("");
	if (data.decisions.length > 0) {
		lines.push("## 关键决策");
		lines.push("");
		lines.push("| 决策 | 依据 |");
		lines.push("| --- | --- |");
		for (const decision of data.decisions) lines.push(`| ${oneLine(decision.decision).replace(/\|/g, "\\|")} | ${oneLine(decision.rationale).replace(/\|/g, "\\|")} |`);
		lines.push("");
	}
	lines.push("## 当前状态");
	lines.push("");
	lines.push(data.state.current !== "" ? data.state.current : "（未归纳出当前状态）");
	lines.push("");
	const stateFiles = data.state.files.length > 0 ? data.state.files : facts.files.slice(0, 20);
	if (stateFiles.length > 0) {
		lines.push("相关文件：");
		lines.push("");
		for (const file of stateFiles.slice(0, 40)) lines.push(`- \`${file}\``);
		lines.push("");
	}
	if (data.state.blockers.length > 0) {
		lines.push("阻塞与风险：");
		lines.push("");
		for (const blocker of data.state.blockers) lines.push(`- ${blocker}`);
		lines.push("");
	}
	lines.push("## 下一步");
	lines.push("");
	if (data.nextSteps.length === 0) lines.push("1. 先核对上面的当前状态，再决定下一步。");
	else data.nextSteps.forEach((step, index) => {
		lines.push(`${index + 1}. **${oneLine(step.step)}**${step.why !== "" ? ` —— ${oneLine(step.why)}` : ""}`);
	});
	lines.push("");
	if (data.memoryCandidates.length > 0) {
		lines.push("## 记忆候选（跨会话仍然成立）");
		lines.push("");
		for (const candidate of data.memoryCandidates) lines.push(`- \`${candidate.scope}\` ${candidate.text}`);
		lines.push("");
	}
	if (facts.files.length > 0) {
		lines.push("## 参考文件");
		lines.push("");
		for (const file of facts.files.slice(0, 80)) lines.push(`- \`${file}\``);
		lines.push("");
	}
	lines.push("## 附录：工具活动");
	lines.push("");
	if (facts.tools.length === 0) lines.push("（本次会话没有工具调用）");
	else {
		lines.push("| seq | 工具 | 状态 | 摘要 |");
		lines.push("| --- | --- | --- | --- |");
		for (const tool of facts.tools.slice(-60)) {
			const detail = oneLine(tool.commands[0] ?? tool.files[0] ?? tool.argumentsExcerpt).replace(/\|/g, "\\|").slice(0, 160);
			lines.push(`| ${tool.seq} | ${tool.name} | ${tool.failed ? "失败" : "ok"} | ${detail} |`);
		}
	}
	lines.push("");
	lines.push("---");
	lines.push(`<!-- generated by dsh-session-handoff at ${iso(facts.capturedAt)}; source session ${facts.sessionId} -->`);
	lines.push("");
	return fenceSafe(lines.join("\n"));
}
/** 结构化交接数据文件（供机器读/二次消费）。 */
function renderJson(facts, data, meta) {
	return `${JSON.stringify({
		schema: "dsh-session-handoff/v1",
		generatedAt: iso(facts.capturedAt),
		llm: meta.llm,
		model: meta.model ?? null,
		degraded: [...meta.degraded],
		source: {
			sessionId: facts.sessionId,
			title: facts.title,
			cwd: facts.cwd,
			createdAt: facts.createdAt,
			events: facts.eventCount,
			toolCalls: facts.tools.length,
			files: facts.files,
			commands: facts.commands
		},
		handoff: data
	}, null, 2)}\n`;
}
/** 新会话提示词：内联摘要（受预算约束）+ 交接文档绝对路径 + 参考文件。 */
/** 交接要求：固定四条，客户端与服务端必须一致。 */
const HANDOFF_REQUIREMENTS = [
	"先用 Read 打开交接文档，确认当前状态，不要凭上面的摘要猜测细节。",
	"从「下一步」第一项开始执行；如果发现状态与文档不一致，先说明差异再调整计划。",
	"需要修改的文件优先在「参考文件」里找；新发现的重要文件补进交接文档。",
	"完成后在回复里说明：本次目标、实际改动、验证方式。"
];
/** 把事实集与归纳结果展开成提示词分段。 */
function buildPromptParts(facts, data, paths) {
	const options = (data.state.files.length > 0 ? data.state.files : facts.files).slice(0, 40);
	return {
		title: data.title,
		sessionId: facts.sessionId,
		docPath: paths.doc,
		dataPath: paths.json,
		summary: data.summary !== "" ? oneLine(data.summary) : "（见交接文档）",
		goal: data.goal !== "" ? data.goal : "（见交接文档）",
		completed: [...data.completed],
		nextSteps: data.nextSteps.map((step) => ({
			step: oneLine(step.step),
			why: oneLine(step.why)
		})),
		blockers: [...data.state.blockers],
		references: options.slice(0, 12),
		referenceOptions: options,
		requirements: [...HANDOFF_REQUIREMENTS]
	};
}
/** 由提示词分段组装最终文本；references 由调用方决定（预览里可勾选）。 */
function composePrompt(parts, references = parts.references) {
	const lines = [];
	lines.push(`# 会话接力：${parts.title}`);
	lines.push("");
	lines.push(`上一会话（\`${parts.sessionId}\`）已完成一轮工作，下面是它的交接材料。`);
	lines.push("");
	lines.push("## 先读这两份文件");
	lines.push(`- 交接文档（必读）：\`${parts.docPath}\``);
	lines.push(`- 结构化数据：\`${parts.dataPath}\``);
	lines.push("");
	lines.push("## 一句话状态");
	lines.push(parts.summary);
	lines.push("");
	lines.push("## 目标");
	lines.push(parts.goal);
	lines.push("");
	if (parts.completed.length > 0) {
		lines.push("## 已完成");
		for (const item of parts.completed) lines.push(`- ${item}`);
		lines.push("");
	}
	if (parts.nextSteps.length > 0) {
		lines.push("## 下一步");
		parts.nextSteps.forEach((step, index) => {
			lines.push(`${index + 1}. ${step.step}${step.why !== "" ? ` —— ${step.why}` : ""}`);
		});
		lines.push("");
	}
	if (parts.blockers.length > 0) {
		lines.push("## 阻塞与风险");
		for (const blocker of parts.blockers) lines.push(`- ${blocker}`);
		lines.push("");
	}
	if (references.length > 0) {
		lines.push("## 参考文件");
		for (const file of references) lines.push(`- \`${file}\``);
		lines.push("");
	}
	lines.push("## 交接要求");
	parts.requirements.forEach((requirement, index) => lines.push(`${index + 1}. ${requirement}`));
	return lines.join("\n");
}
/** 新会话提示词：默认组装 + 预算内截断（超预算时改用紧凑版）。 */
function buildPromptText(facts, data, paths, budget) {
	const parts = buildPromptParts(facts, data, paths);
	const text = composePrompt(parts);
	if (text.length <= budget) return text;
	const compact = [];
	compact.push(`# 会话接力：${parts.title}`);
	compact.push("");
	compact.push(`上一会话（\`${parts.sessionId}\`）的交接材料：\`${parts.docPath}\`（结构化数据：\`${parts.dataPath}\`）。`);
	compact.push("");
	compact.push("## 一句话状态");
	compact.push(parts.summary);
	compact.push("");
	compact.push("## 下一步");
	(parts.nextSteps.length > 0 ? parts.nextSteps : [{
		step: "阅读交接文档确认现状后继续",
		why: ""
	}]).slice(0, 6).forEach((step, index) => {
		compact.push(`${index + 1}. ${step.step}${step.why !== "" ? ` —— ${step.why}` : ""}`);
	});
	compact.push("");
	compact.push("先读交接文档，再按上面的顺序继续；状态不一致时先说明差异。");
	const out = compact.join("\n");
	return out.length <= budget ? out : `${out.slice(0, budget)}\n…（提示词已按预算截断，完整内容见交接文档）`;
}
/** 本地时间戳（台账给人读，不用 UTC 的 ISO 截断）。 */
function localStamp(ms) {
	const date = new Date(ms);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 记忆台账的新增片段（已存在的内容不重复追加）。 */
function memoryDelta(existing, data, facts) {
	const candidates = data.memoryCandidates;
	if (candidates.length === 0) return {
		block: "",
		added: 0
	};
	const fresh = candidates.filter((candidate) => !existing.includes(candidate.text));
	if (fresh.length === 0) return {
		block: "",
		added: 0
	};
	const stamp = localStamp(facts.capturedAt);
	const lines = [];
	lines.push("");
	lines.push(`## ${stamp} · ${data.title}`);
	lines.push("");
	lines.push(`来源：交接文档（session \`${facts.sessionId}\`）`);
	lines.push("");
	for (const candidate of fresh) lines.push(`- \`${candidate.scope}\` ${candidate.text}`);
	lines.push("");
	return {
		block: lines.join("\n"),
		added: fresh.length
	};
}
/** 记忆台账骨架。 */
const MEMORY_HEADER = `# 交接记忆

> 由 dsh-session-handoff 维护：跨会话仍然成立的项目约定、用户偏好与环境事实。
> 每个条目都来自某次会话的交接归纳；重复内容不会重复追加，可随时人工删改。
`;
// src/host/summary.ts
/** max-tokens 截断时允许一次翻倍重试的硬上限。 */
const MAX_RETRY_TOKENS = 16384;
/** 固定摘要协议：只输出一个 JSON 对象。 */
const SYSTEM_PROMPT = `你是会话交接编辑。你会收到一个编码 Agent 会话的结构化事实集，需要把它写成「下一个会话可以直接接着干」的交接材料。

只输出一个 JSON 对象，不要 Markdown 代码围栏，不要额外说明。字段固定：
{
  "title": "≤24 字的会话标题（动宾结构）",
  "summary": "≤120 字，一句话说明做到哪了",
  "goal": "用户真正的目标与约束（≤300 字）",
  "completed": ["已完成的工作，每条 ≤80 字，带可验证结果（文件/命令/结论）"],
  "decisions": [{"decision": "已定决策", "rationale": "依据/取舍"}],
  "state": {"current": "当前状态（≤200 字）", "files": ["相关文件路径"], "blockers": ["阻塞或风险"]},
  "nextSteps": [{"step": "下一步动作", "why": "为什么它排在这里"}],
  "memoryCandidates": [{"text": "值得长期记住的一句话（偏好/约定/事实/教训）", "scope": "memory|user|project"}]
}

规则：
1. 只写事实集里出现过的东西，不要编造文件名、结论或数字。
2. completed 用「动词 + 对象 + 结果」；没有结果就写「已起草，未验证」。
3. nextSteps 按依赖顺序排列，第一条必须能在新会话立刻执行。
4. memoryCandidates 只放跨会话仍然成立的内容（用户偏好、项目约定、环境事实、可复用教训），不要放本次任务的进度；没有就输出空数组。
5. 中文输出；代码标识符、路径、命令保持原文。`;
function clip(value, max) {
	const text = typeof value === "string" ? value.trim() : "";
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function textList(value, itemMax, limit) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim() !== "") out.push(clip(item, itemMax));
		if (out.length >= limit) break;
	}
	return out;
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/** 从模型输出里取出 JSON 并按协议做宽松校验（字段缺失即降级，不抛给用户）。 */
function parseHandoff(raw) {
	const cleaned = raw.replace(/^\uFEFF/, "").trim();
	const candidate = (cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? cleaned).trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	let value;
	try {
		value = JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return;
	}
	const object = record(value);
	if (object === void 0) return void 0;
	const state = record(object["state"]) ?? {};
	const decisions = Array.isArray(object["decisions"]) ? object["decisions"].flatMap((item) => {
		const entry = record(item);
		const decision = clip(entry?.["decision"], 160);
		if (decision === "") return [];
		return [{
			decision,
			rationale: clip(entry?.["rationale"], 240)
		}];
	}).slice(0, 12) : [];
	const nextSteps = Array.isArray(object["nextSteps"]) ? object["nextSteps"].flatMap((item) => {
		const entry = record(item);
		const step = clip(entry?.["step"], 200);
		if (step === "") return [];
		return [{
			step,
			why: clip(entry?.["why"], 240)
		}];
	}).slice(0, 12) : [];
	const memoryCandidates = Array.isArray(object["memoryCandidates"]) ? object["memoryCandidates"].flatMap((item) => {
		const entry = record(item);
		const text = clip(entry?.["text"], 240);
		if (text === "") return [];
		const scope = entry?.["scope"];
		return [{
			text,
			scope: scope === "user" || scope === "project" ? scope : "memory"
		}];
	}).slice(0, 12) : [];
	return {
		title: clip(object["title"], 48) || "会话交接",
		summary: clip(object["summary"], 240),
		goal: clip(object["goal"], 600),
		completed: textList(object["completed"], 200, 20),
		decisions,
		state: {
			current: clip(state["current"], 500),
			files: textList(state["files"], 300, 40),
			blockers: textList(state["blockers"], 300, 12)
		},
		nextSteps,
		memoryCandidates
	};
}
/** 取第一行/第一句，压缩空白。 */
function firstLine(text, max = 160) {
	return clip(text.split(/\n/).find((line) => line.trim() !== "") ?? "", max);
}
/**
* 从助手正文里剥离代码围栏与 dsh-ui JSON，只留可读的散文。
* 会话里大量 assistant 输出是 UI 规格/JSON，直接截断会产生「```dsh-ui」这种垃圾摘要。
*/
function proseOf(text, max) {
	let value = String(text ?? "");
	value = value.replace(/```[\s\S]*?(?:```|$)/g, "");
	value = value.replace(/[\u200b-\u200d\ufeff]/g, "");
	return clip(value.split("\n").filter((line) => {
		const trimmed = line.trim();
		if (trimmed === "") return true;
		if (/^#{1,6}\s/.test(trimmed)) return false;
		if (/^[-*_]{3,}$/.test(trimmed)) return false;
		if (/^\|/.test(trimmed)) return false;
		if (/^[\[{]/.test(trimmed)) return false;
		if (/^```/.test(trimmed)) return false;
		return true;
	}).join("\n").split(/\n{2,}/).map((part) => part.replace(/\s+/g, " ").trim()).filter((part) => part.length >= 12)[0] ?? "", max);
}
/** 确定性兜底：不调用模型，用事实集拼出可用但不精致的交接内容。 */
function fallbackData(facts) {
	const asks = facts.userMessages;
	const latest = asks.at(-1) ?? "";
	const first = asks[0] ?? "";
	const title = facts.title !== "" ? facts.title : firstLine(latest !== "" ? latest : first, 48).replace(/[。！？!?].*$/, "") || "会话交接";
	const completed = [];
	const seen = /* @__PURE__ */ new Set();
	for (const text of facts.assistantTexts.slice(-6)) {
		const prose = proseOf(text, 160);
		if (prose.length < 8 || seen.has(prose)) continue;
		seen.add(prose);
		completed.push(prose);
	}
	let current = "";
	for (const text of [...facts.assistantTexts].reverse()) {
		current = proseOf(text, 300);
		if (current !== "") break;
	}
	const blockers = facts.failures.slice(-5).map((failure) => `历史失败：${clip(failure, 240)}`);
	const latestAsk = firstLine(latest, 120);
	return {
		title,
		summary: latestAsk !== "" ? `最近一次诉求：${latestAsk}` : `共 ${facts.eventCount} 条事件、${facts.tools.length} 次工具调用`,
		goal: latest !== "" ? clip(latest, 600) : first !== "" ? clip(first, 600) : "（未记录到用户诉求）",
		completed: completed.slice(-5),
		decisions: [],
		state: {
			current: current !== "" ? current : "（模型摘要不可用，且未找到可读的助手正文；请看参考文件与工具附录）",
			files: facts.files.slice(0, 40),
			blockers
		},
		nextSteps: [...latestAsk !== "" ? [{
			step: `先读交接文档，再继续处理：${latestAsk}`,
			why: "模型摘要不可用，以最近一次诉求作为继续点"
		}] : [], {
			step: "核对参考文件与当前工作区状态，再决定下一步",
			why: "确定性摘要不含推断，只保留事实"
		}].slice(0, 2),
		memoryCandidates: []
	};
}
/** 把事实集渲染成模型可读的 Markdown 摘要输入（带字符预算，保头保尾）。 */
function buildDigest(facts, maxChars) {
	const lines = [];
	const push = (line) => {
		lines.push(line);
	};
	push(`# 会话事实集`);
	push("");
	push(`- 会话：${facts.title !== "" ? facts.title : "(无标题)"}（${facts.sessionId}）`);
	push(`- 工作目录：${facts.cwd !== "" ? facts.cwd : "(未知)"}`);
	push(`- 事件数：${facts.eventCount}；工具调用：${facts.tools.length}；涉及文件：${facts.files.length}`);
	if (facts.lastRoute !== void 0) push(`- 会话模型：${facts.lastRoute.provider}/${facts.lastRoute.model}`);
	push("");
	push(`## 用户诉求（按时间，共 ${facts.userMessages.length} 条）`);
	facts.userMessages.forEach((message, index) => {
		push(`${index + 1}. ${message}`);
	});
	if (facts.injectedMessages.length > 0) {
		push("");
		push("## 注入上下文（非用户直接输入，摘录）");
		push(facts.injectedMessages.slice(-8).map((message) => `- ${message}`).join("\n"));
	}
	push("");
	push(`## 助手进展（按时间，最多保留 ${facts.assistantTexts.length} 条）`);
	facts.assistantTexts.forEach((text, index) => {
		push(`### 进展 ${index + 1}\n${text}`);
	});
	if (facts.compactionSummaries.length > 0) {
		push("");
		push("## 历史压缩摘要");
		facts.compactionSummaries.forEach((text, index) => {
			push(`### 摘要 ${index + 1}\n${text}`);
		});
	}
	push("");
	push(`## 工具活动（按时间，${facts.tools.length} 条）`);
	for (const tool of facts.tools) {
		const status = tool.failed ? "失败" : "ok";
		const detail = tool.commands[0] ?? tool.files[0] ?? tool.argumentsExcerpt;
		push(`- [${tool.seq}] ${tool.name}（${status}）：${clip(detail, 220)}`);
	}
	if (facts.failures.length > 0) {
		push("");
		push("## 失败与阻塞");
		facts.failures.forEach((failure) => push(`- ${failure}`));
	}
	if (facts.files.length > 0) {
		push("");
		push("## 涉及文件");
		facts.files.slice(0, 120).forEach((file) => push(`- ${file}`));
	}
	if (facts.commands.length > 0) {
		push("");
		push("## 执行过的命令（去重）");
		facts.commands.slice(0, 60).forEach((command) => push(`- \`${clip(command, 200)}\``));
	}
	const body = lines.join("\n");
	if (body.length <= maxChars) return body;
	const head = Math.floor(maxChars * .6);
	const tail = maxChars - head;
	return `${body.slice(0, head)}\n\n…（中间 ${body.length - maxChars} 字已省略）…\n\n${body.slice(-tail)}`;
}
async function readCompletion(stream) {
	let text = "";
	let finished = false;
	let finish = "unknown";
	for await (const chunk of stream) {
		if (chunk === null || typeof chunk !== "object") continue;
		if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
		else if (chunk.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") text = chunk.block.text === "" ? text : chunk.block.text;
		else if (chunk.type === "finish") {
			finished = true;
			finish = chunk.reason?.kind ?? "unknown";
			if (finish === "error" || finish === "aborted") {
				const code = chunk.reason?.failure?.code ?? finish;
				throw new Error(`模型以 ${finish} 结束（${code}）`);
			}
		}
	}
	if (!finished) throw new Error("模型流未给出终止原因");
	return {
		text: text.trim(),
		finish
	};
}
/** 调用一次模型做归纳；失败时不抛出，交给调用方降级。 */
async function summarize(runtime, facts, config, signal) {
	const degraded = [];
	const route = config.provider !== "" && config.model !== "" ? {
		provider: config.provider,
		model: config.model
	} : facts.lastRoute;
	if (runtime.llm === void 0) {
		degraded.push("llm-unavailable");
		return {
			data: fallbackData(facts),
			llm: false,
			degraded
		};
	}
	if (route === void 0) {
		degraded.push("no-model-route");
		return {
			data: fallbackData(facts),
			llm: false,
			degraded
		};
	}
	const digest = buildDigest(facts, config.maxInputChars);
	const attempt = async (maxTokens) => {
		const completion = await readCompletion(runtime.llm.stream({
			provider: route.provider,
			model: route.model,
			system: SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: digest
				}]
			}],
			temperature: 0,
			maxTokens,
			signal
		}));
		return {
			parsed: parseHandoff(completion.text),
			finish: completion.finish
		};
	};
	try {
		let result = await attempt(config.maxTokens);
		if (result.parsed === void 0 && result.finish === "max-tokens" && config.maxTokens < MAX_RETRY_TOKENS) {
			const retryTokens = Math.min(MAX_RETRY_TOKENS, config.maxTokens * 2);
			degraded.push(`llm-retried-max-tokens:${config.maxTokens}→${retryTokens}`);
			result = await attempt(retryTokens);
		}
		if (result.parsed === void 0) {
			degraded.push(`llm-unparseable:${result.finish}`);
			return {
				data: fallbackData(facts),
				llm: false,
				degraded
			};
		}
		if (result.finish === "max-tokens") degraded.push("llm-max-tokens-accepted");
		return {
			data: result.parsed,
			llm: true,
			model: `${route.provider}/${route.model}`,
			degraded
		};
	} catch (cause) {
		degraded.push(`llm-failed:${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300));
		return {
			data: fallbackData(facts),
			llm: false,
			degraded
		};
	}
}
// src/host/index.ts
/**
* dsh-session-handoff 宿主半：会话读取 → 确定性采集 → LLM 归纳 → 交接文档落盘 → 新会话提示词。
*
* 只注册两条只读/单次写路由，不向会话日志追加事件，不修改会话本身：
*   GET  /session-handoff/health   能力探测（浏览器半用于降级提示）
*   POST /session-handoff/prepare  生成交接包（需要 x-dsh-handoff: 1 头，挡跨站表单）
*
* 端点在本机同源下工作；写入范围限制在当前会话 cwd 的配置目录内。
*
* @module dsh-session-handoff
*/
/** 版本号：与 package.json 保持一致（宿主半不 import JSON，避免 loader 差异）。 */
const VERSION = "0.2.5";
const PREFIX = "[dsh-session-handoff]";
const ROUTE_HEALTH = "/session-handoff/health";
const ROUTE_PREPARE = "/session-handoff/prepare";
/** 单次生成的最大等待时间之外的绝对上限（配置值再夹取）。 */
const MAX_TIMEOUT_MS = 9e5;
/** 记忆台账软上限；超过则滚动为 .1 备份。 */
const MEMORY_LIMIT_BYTES = 262144;
/** 浏览器半必须带的自定义头，避免被跨站简单请求触发。 */
const REQUIRED_HEADER = "x-dsh-handoff";
/** 等待 webServer；其余能力按可选处理（缺失时降级而不是拒绝加载）。 */
const inject = ["webServer"];
var HandoffError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
function log(ctx, level, message) {
	const logger = ctx.logger;
	if (logger !== void 0 && typeof logger[level] === "function") logger[level](`${PREFIX} ${message}`);
	else if (level === "warn") console.warn(`${PREFIX} ${message}`);
	else console.log(`${PREFIX} ${message}`);
}
function service(ctx, name) {
	if (typeof ctx.get === "function") {
		const resolved = ctx.get(name, false);
		if (resolved !== void 0 && resolved !== null) return resolved;
	}
	try {
		const direct = ctx[name];
		if (direct !== void 0) return direct;
	} catch {}
}
function respond(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(body));
}
function headerValue(req, name) {
	const value = req.headers?.[name];
	return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}
/** 读取并解析 JSON 请求体，限制字节数（畸形输入一律 400）。 */
async function readJsonBody(req, maxBytes) {
	if (typeof req[Symbol.asyncIterator] !== "function") throw new HandoffError("bad-request", "请求体不可读");
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new HandoffError("body-too-large", `请求体超过 ${maxBytes} 字节`, 413);
		chunks.push(chunk);
	}
	if (total === 0) return {};
	const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new HandoffError("bad-json", "请求体不是合法 JSON");
	}
}
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** 只接受本机同源的按钮请求。 */
function assertSameOrigin(req) {
	if (headerValue(req, REQUIRED_HEADER) !== "1") throw new HandoffError("forbidden", `缺少 ${REQUIRED_HEADER}: 1 请求头`, 403);
	const origin = headerValue(req, "origin");
	if (origin === "") return;
	let host = "";
	try {
		host = new URL(origin).host;
	} catch {
		throw new HandoffError("forbidden", "Origin 非法", 403);
	}
	const target = headerValue(req, "host");
	if (target !== "" && host !== target) throw new HandoffError("forbidden", "跨站请求被拒绝", 403);
}
/** 把派生消息包装成伪事件序列，作为没有 sessionQuery 时的降级读取。 */
function eventsFromMessages(messages) {
	const events = [];
	const now = Date.now();
	messages.forEach((raw, index) => {
		const message = raw !== null && typeof raw === "object" ? raw : void 0;
		if (message === void 0) return;
		const role = message["role"];
		const data = { message: {
			...message,
			role
		} };
		const type = role === "assistant" ? "assistant/message" : role === "tool" ? "tool/result" : role === "user" ? "user/message" : "";
		if (type === "") return;
		events.push({
			type,
			seq: index + 1,
			time: now,
			data: type === "user/message" ? {
				content: message["content"],
				source: { kind: "user" }
			} : data
		});
	});
	return events;
}
/** 读取一份会话日志：优先 sessionQuery（live 优先、可读归档），否则退回活会话派生消息。 */
async function readSnapshot(ctx, sessionId) {
	const query = service(ctx, "sessionQuery");
	if (query !== void 0 && typeof query.readSession === "function") {
		let snapshot;
		try {
			snapshot = await query.readSession(sessionId);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (/not[ _-]?found|unknown session|no such|missing session/i.test(message)) throw new HandoffError("session-not-found", `找不到会话 ${sessionId}`, 404);
			throw new HandoffError("internal", `读取会话失败：${message}`, 500);
		}
		if (snapshot === void 0 || snapshot.session === void 0) throw new HandoffError("session-not-found", `找不到会话 ${sessionId}`, 404);
		return {
			snapshot,
			degraded: []
		};
	}
	const live = service(ctx, "sessions")?.get?.(sessionId);
	if (live === void 0) throw new HandoffError("session-not-found", `找不到会话 ${sessionId}（缺少 sessionQuery 且会话不在内存）`, 404);
	const messages = typeof live.deriveMessages === "function" ? live.deriveMessages() : [];
	return {
		snapshot: {
			session: { id: sessionId },
			events: eventsFromMessages(messages)
		},
		degraded: ["no-session-query"]
	};
}
function normalizeTitle(value) {
	return typeof value === "string" ? value.trim() : "";
}
/** 执行一次交接生成。 */
async function prepare(ctx, config, sessionId) {
	const started = Date.now();
	const read = await readSnapshot(ctx, sessionId);
	const facts = collectFacts(read.snapshot, {
		...COLLECT_LIMITS,
		maxToolCalls: config.maxToolCalls
	});
	for (const marker of read.degraded) facts.degraded.push(marker);
	if (facts.cwd === "") throw new HandoffError("no-cwd", "会话没有工作目录（cwd），无法写入交接文档", 409);
	if (!isAbsolute(facts.cwd)) throw new HandoffError("no-cwd", `会话工作目录不是绝对路径：${facts.cwd}`, 409);
	const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1e3, config.timeoutMs));
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(/* @__PURE__ */ new Error(`摘要超时（${timeout}ms）`));
	}, timeout);
	const llm = service(ctx, "llm");
	let outcome;
	try {
		outcome = await summarize({ llm }, facts, config, controller.signal);
	} finally {
		clearTimeout(timer);
	}
	const data = outcome.data;
	if (normalizeTitle(facts.title) !== "" && normalizeTitle(data.title) === "") data.title = facts.title;
	const references = await filterReferences(facts.cwd, [...data.state.files, ...facts.files]);
	facts.files = references;
	if (data.state.files.length > 0) data.state.files = references;
	const root = resolveInside(facts.cwd, config.dir);
	let memoryPath;
	if (config.writeMemory && data.memoryCandidates.length > 0) {
		const memoryFile = join(root, config.memoryFile);
		try {
			const existing = await exists(memoryFile);
			const { block, added } = memoryDelta(existing ? await readFile(memoryFile, "utf8") : "", data, facts);
			if (added > 0) {
				await appendWithRoll(memoryFile, MEMORY_HEADER, block, MEMORY_LIMIT_BYTES);
				memoryPath = memoryFile;
				log(ctx, "info", `记忆台账追加 ${added} 条 → ${memoryFile}`);
			} else if (existing) memoryPath = memoryFile;
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			facts.degraded.push(`memory-write-failed:${detail}`.slice(0, 300));
			log(ctx, "warn", `记忆台账写入失败，已降级：${detail}`);
		}
	}
	const meta = {
		...outcome.model === void 0 ? {} : { model: outcome.model },
		llm: outcome.llm,
		degraded: [...facts.degraded, ...outcome.degraded]
	};
	const runDir = await createRunDir(root, `${stamp(facts.capturedAt)}-${slug(data.title)}`);
	const docPath = join(runDir, "WorkSummary.md");
	const dataPath = join(runDir, "handoff.json");
	const markdown = renderMarkdown(facts, data, meta);
	const json = renderJson(facts, data, meta);
	await writeAtomic(docPath, markdown);
	await writeAtomic(dataPath, json);
	const paths = {
		doc: docPath,
		json: dataPath
	};
	const promptParts = buildPromptParts(facts, data, paths);
	const promptText = buildPromptText(facts, data, paths, config.promptCharBudget);
	log(ctx, "info", `交接完成：${sessionId} → ${docPath}（llm=${outcome.llm}${meta.model !== void 0 ? `, ${meta.model}` : ""}, ${Date.now() - started}ms）`);
	return {
		ok: true,
		sessionId,
		title: data.title,
		promptText,
		promptParts,
		preview: config.preview,
		markdown,
		data,
		docPath,
		dataPath,
		...memoryPath === void 0 ? {} : { memoryPath },
		memoryCandidates: data.memoryCandidates,
		autoSend: config.autoSend,
		degraded: meta.degraded,
		stats: {
			events: facts.eventCount,
			toolCalls: facts.tools.length,
			files: facts.files.length,
			chars: markdown.length,
			llm: outcome.llm,
			...outcome.model === void 0 ? {} : { model: outcome.model },
			durationMs: Date.now() - started
		}
	};
}
/** 插件入口。 */
function apply(ctx, rawConfig) {
	const { config, warnings } = readConfig(rawConfig ?? DEFAULTS);
	for (const warning of warnings) log(ctx, "warn", `配置告警：${warning}`);
	const capabilities = {
		sessionQuery: service(ctx, "sessionQuery") !== void 0,
		sessions: service(ctx, "sessions") !== void 0,
		llm: service(ctx, "llm") !== void 0
	};
	log(ctx, "info", `已加载 v${VERSION}（${Object.entries(capabilities).map(([key, value]) => `${key}=${value ? "on" : "off"}`).join(", ")}）`);
	const register = (path, handler) => {
		const webServer = ctx.webServer;
		if (webServer === void 0) {
			log(ctx, "warn", "缺少 webServer，交接端点未注册");
			return;
		}
		const bind = () => webServer.register({
			kind: "exact",
			path,
			handler
		});
		if (typeof ctx.effect === "function") try {
			ctx.effect(() => bind(), `dsh-session-handoff: route ${path}`);
			return;
		} catch (cause) {
			log(ctx, "warn", `路由 ${path} 未能绑定 fiber，改为直接注册：${cause instanceof Error ? cause.message : String(cause)}`);
		}
		bind();
	};
	register(ROUTE_HEALTH, (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			respond(res, 405, {
				ok: false,
				code: "method-not-allowed",
				message: "只支持 GET"
			});
			return;
		}
		respond(res, 200, {
			ok: true,
			plugin: "dsh-session-handoff",
			version: VERSION,
			enabled: config.enabled,
			capabilities,
			config: {
				dir: config.dir,
				writeMemory: config.writeMemory,
				autoSend: config.autoSend,
				preview: config.preview,
				route: config.provider !== "" && config.model !== "" ? `${config.provider}/${config.model}` : "session"
			},
			warnings
		});
	});
	register(ROUTE_PREPARE, (req, res) => {
		(async () => {
			try {
				if (req.method !== "POST") throw new HandoffError("method-not-allowed", "只支持 POST", 405);
				assertSameOrigin(req);
				if (!config.enabled) throw new HandoffError("disabled", "会话接力已在配置中关闭", 503);
				const body = await readJsonBody(req, config.maxBodyBytes);
				const record = body !== null && typeof body === "object" ? body : {};
				const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"].trim() : "";
				if (!SESSION_ID.test(sessionId)) throw new HandoffError("bad-session", "sessionId 缺失或格式不合法");
				respond(res, 200, await prepare(ctx, config, sessionId));
			} catch (cause) {
				const error = cause instanceof HandoffError ? cause : new HandoffError("internal", cause instanceof Error ? cause.message : String(cause), 500);
				log(ctx, "warn", `${error.code}: ${error.message}`);
				respond(res, error.status, {
					ok: false,
					code: error.code,
					message: error.message
				});
			}
		})();
	});
}
export { VERSION, apply, inject };
