window.__ModuleLoader__.load({
	id: "dsh-session-handoff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/client/open.ts
		function softGet$1(ctx, name) {
			if (typeof ctx.get !== "function") return void 0;
			try {
				return ctx.get(name, false);
			} catch {
				return;
			}
		}
		function errorMessage$1(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		function createOptions(hint) {
			if (hint.workspaceId !== void 0) return { workspaceId: hint.workspaceId };
			if (hint.cwd !== void 0) return { cwd: hint.cwd };
			return {};
		}
		/** 通过 sessions.retain 拿到已绑定会话再入队一轮。 */
		async function sendToSession(sessions, sessionId, text) {
			if (typeof sessions.retain !== "function") throw new Error("缺少 sessions.retain");
			const ref = sessions.retain(sessionId, { source: "handoff" });
			let timer;
			try {
				await Promise.race([Promise.resolve(ref.ready).catch(() => void 0), new Promise((_, reject) => {
					timer = setTimeout(() => reject(/* @__PURE__ */ new Error("会话打开超时")), 1e4);
				})]);
				const session = ref.binding?.session;
				if (session === void 0 || typeof session.prompt !== "function") throw new Error("会话不可用");
				const result = await session.prompt([{
					type: "text",
					text
				}], "queue");
				if (result !== void 0 && result.ok === false) throw new Error(result.error?.message ?? "发送失败");
			} finally {
				if (timer !== void 0) clearTimeout(timer);
				ref.release?.();
			}
		}
		/** 把提示词写进新会话；返回发送方式。 */
		async function openWithPrompt(ctx, promptText, autoSend, hint = {}) {
			const nav = softGet$1(ctx, "uiWorkspace");
			const sessions = softGet$1(ctx, "sessions");
			if (autoSend && sessions !== void 0 && typeof sessions.create === "function" && nav?.openSession !== void 0) try {
				const created = await sessions.create(createOptions(hint));
				const sessionId = String(created ?? "");
				if (sessionId === "") throw new Error("sessions.create 未返回会话 id");
				await sendToSession(sessions, sessionId, promptText);
				nav.openSession(sessionId);
				return "sent";
			} catch (cause) {
				console.warn(`[dsh-session-handoff] 自动发送失败，改为预填草稿：${errorMessage$1(cause)}`);
			}
			if (nav !== void 0 && typeof nav.startSession === "function") {
				nav.startSession(hint.workspaceId, { prompt: promptText });
				return "draft";
			}
			if (sessions !== void 0 && typeof sessions.create === "function") {
				const sessionId = String(await sessions.create(createOptions(hint)) ?? "");
				if (sessionId === "") throw new Error("sessions.create 未返回会话 id");
				await sendToSession(sessions, sessionId, promptText);
				nav?.openSession?.(sessionId);
				return "sent";
			}
			throw new Error("当前 DSH 缺少创建会话的入口（uiWorkspace.startSession / sessions.create）");
		}
		/** 失败兜底：提示词进剪贴板，避免用户丢失摘要。 */
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				throw new Error("剪贴板不可用，请手动复制");
			}
		}
		// src/client/compose.ts
		/** 由结构化分段组装提示词；references 为空数组时不渲染「参考文件」小节。 */
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
		// src/client/store.ts
		let state = { phase: "idle" };
		const listeners = /* @__PURE__ */ new Set();
		/** 预览状态存储（getSnapshot 必须返回稳定引用，状态变化时整体替换）。 */
		const previewStore = {
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			getState() {
				return state;
			},
			set(next) {
				state = next;
				for (const listener of listeners) listener();
			},
			idle() {
				previewStore.set({ phase: "idle" });
			}
		};
		/** 最近一次渲染过的会话（快捷键在没有渲染上下文时用它定位目标）。 */
		let active;
		/** 当前活跃会话与落点提示。 */
		const activeSession = {
			get() {
				return active;
			},
			set(sessionId, hint) {
				active = {
					sessionId,
					hint
				};
			},
			clear() {
				active = void 0;
			}
		};
		// src/client/ui.ts
		/**
		* 浏览器半的样式与轻量反馈件（零第三方依赖，全部走 DSH 的 --dsw-* 变量）。
		*
		* 不 import 设计系统组件：动态包的 factory 只保证 React 基线，样式通过一次性
		* <style> 注入，跟随主题切换（token 由页面根注入）。
		*
		* @module dsh-session-handoff/client/ui
		*/
		const CLS = {
			button: "dsh-handoff-btn",
			spinner: "dsh-handoff-spinner",
			toast: "dsh-handoff-toast",
			toastError: "dsh-handoff-toast-error",
			backdrop: "dsh-handoff-backdrop",
			card: "dsh-handoff-card",
			cardHead: "dsh-handoff-card-head",
			cardBody: "dsh-handoff-card-body",
			cardFoot: "dsh-handoff-card-foot",
			label: "dsh-handoff-label",
			summary: "dsh-handoff-summary",
			prompt: "dsh-handoff-prompt",
			refs: "dsh-handoff-refs",
			ref: "dsh-handoff-ref",
			actions: "dsh-handoff-actions",
			action: "dsh-handoff-action",
			actionPrimary: "dsh-handoff-action-primary",
			meta: "dsh-handoff-meta",
			candidates: "dsh-handoff-candidates",
			error: "dsh-handoff-card-error"
		};
		const STYLE_ID = "dsh-session-handoff-style";
		const CSS = `
.${CLS.button} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; flex: none;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.${CLS.button}:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.${CLS.button}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.${CLS.button}[data-busy="true"] { pointer-events: none; opacity: .7; }
.${CLS.button}[data-done="true"] { color: var(--dsw-alias-state-success-primary, #2f9e44); }
.${CLS.button}[data-error="true"] { color: var(--dsw-alias-state-error-primary, #e03131); }
.${CLS.spinner} {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor; animation: dsh-handoff-spin .7s linear infinite;
}
@keyframes dsh-handoff-spin { to { transform: rotate(360deg); } }
.${CLS.toast} {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
  z-index: 2147483000; max-width: min(560px, 86vw);
  padding: 9px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, #1f1f22);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  box-shadow: var(--dsw-elevation-panel, 0 8px 28px rgba(0,0,0,.28));
  animation: dsh-handoff-in .16s ease-out;
}
.${CLS.toastError} { color: var(--dsw-alias-state-error-primary, #ff8787); }
@keyframes dsh-handoff-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.${CLS.backdrop} {
  position: fixed; inset: 0; z-index: 2147482000; pointer-events: auto;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: color-mix(in srgb, #000 38%, transparent);
  font-family: var(--dsw-font-family, inherit);
}
.${CLS.card} {
  width: min(760px, 94vw); max-height: 84vh; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #1b1b1e); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 14px;
  box-shadow: var(--dsw-elevation-panel, 0 18px 60px rgba(0,0,0,.4)); overflow: hidden;
}
.${CLS.cardHead} { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.${CLS.cardHead} h2 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
.${CLS.cardBody} { padding: 14px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.${CLS.cardFoot} { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.${CLS.label} { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; }
.${CLS.summary} { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); }
.${CLS.prompt} {
  width: 100%; box-sizing: border-box; min-height: 190px; max-height: 320px; resize: vertical;
  padding: 10px 12px; font-size: 12.5px; line-height: 1.6;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base, rgba(0,0,0,.18));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 9px; outline: none;
}
.${CLS.prompt}:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.${CLS.refs} { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px 10px; max-height: 132px; overflow: auto; }
.${CLS.ref} { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.${CLS.ref} span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${CLS.ref} input { accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.${CLS.ref}[data-disabled="true"] { opacity: .55; }
.${CLS.actions} { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.${CLS.action} {
  height: 30px; padding: 0 12px; font-size: 12.5px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
}
.${CLS.action}:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.${CLS.action}:disabled { opacity: .5; cursor: default; }
.${CLS.actionPrimary} {
  height: 30px; padding: 0 14px; font-size: 12.5px; border-radius: 8px; cursor: pointer; border: none;
  color: var(--dsw-alias-brand-primary-invert, #fff); background: var(--dsw-alias-button-primary-fill, #4d6bfe);
}
.${CLS.actionPrimary}:disabled { opacity: .5; cursor: default; }
.${CLS.meta} { font-size: 11px; color: var(--dsw-alias-label-caption); word-break: break-all; }
.${CLS.candidates} { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.${CLS.error} { font-size: 12px; color: var(--dsw-alias-state-error-primary, #ff8787); }
`;
		/** 幂等注入样式。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		let toastTimer;
		/** 一条 3.6s 自动消失的轻提示（不阻塞输入）。 */
		function toast(text, kind = "info") {
			if (typeof document === "undefined") return;
			ensureStyles();
			document.querySelectorAll(`.${CLS.toast}`).forEach((node) => node.remove());
			const node = document.createElement("div");
			node.className = kind === "error" ? `${CLS.toast} ${CLS.toastError}` : CLS.toast;
			node.setAttribute("role", kind === "error" ? "alert" : "status");
			node.textContent = text;
			document.body.appendChild(node);
			if (toastTimer !== void 0) clearTimeout(toastTimer);
			toastTimer = setTimeout(() => {
				node.remove();
			}, 3600);
		}
		/** 接力图标（方框 + 出栈箭头），语义：把当前会话搬到新会话。 */
		function handoffIcon(size = 16) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			}, (0, react.createElement)("path", { d: "M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" }), (0, react.createElement)("path", { d: "M10 8l4 4-4 4" }), (0, react.createElement)("path", { d: "M14 12H4" }));
		}
		/** 加载中的小转圈。 */
		function spinner() {
			return (0, react.createElement)("span", {
				className: CLS.spinner,
				"aria-hidden": "true"
			});
		}
		/**
		* 让按钮在「完成」态停留一秒再复位；返回当前态与触发器。
		* @param resetMs - 成功态停留时间。
		*/
		function useDoneLatch(resetMs = 1200) {
			const [done, setDone] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!done) return void 0;
				const timer = setTimeout(() => {
					setDone(false);
				}, resetMs);
				return () => {
					clearTimeout(timer);
				};
			}, [done, resetMs]);
			return {
				done,
				error,
				succeed: () => {
					setError(false);
					setDone(true);
				},
				fail: () => {
					setDone(false);
					setError(true);
				}
			};
		}
		// src/client/preview.ts
		/**
		* 可编辑预览卡：生成后先让用户看一眼、改一改，再打开新会话。
		*
		* 挂在 root 作用域的 `shell.overlay`（list，点击穿透，条目自行接管指针事件），
		* 所以它不属于某个会话、不会被 composer 裁切；当前会话身份来自预览载荷。
		*
		* @module dsh-session-handoff/client/preview
		*/
		const ZH$1 = {
			"preview.title": "会话交接预览",
			"preview.summary": "一句话状态",
			"preview.next": "下一步",
			"preview.memory": "记忆候选（已写入交接记忆台账）",
			"preview.docs": "交接文档",
			"preview.prompt": "发往新会话的提示词（可编辑）",
			"preview.refs": "参考文件（勾选后重建提示词；手动编辑后锁定）",
			"preview.refsLocked": "提示词已手动编辑，参考文件勾选已锁定；如需调整请重新生成。",
			"preview.open": "打开新会话",
			"preview.copy": "复制提示词",
			"preview.regen": "重新生成",
			"preview.close": "关闭",
			"preview.opening": "正在打开…",
			"preview.regenerating": "正在重新生成…",
			"preview.copied": "提示词已复制",
			"preview.copyPath": "复制文档路径",
			"preview.pathCopied": "文档路径已复制",
			"preview.degraded": "降级生成：",
			"preview.emptyRefs": "（没有识别到参考文件）",
			"preview.sent": "已发送到新会话：",
			"preview.draft": "已在新会话预填提示词：",
			"preview.failed": "打开新会话失败：",
			"preview.regenFailed": "重新生成失败："
		};
		const EN$1 = {
			"preview.title": "Session handoff preview",
			"preview.summary": "Status",
			"preview.next": "Next steps",
			"preview.memory": "Memory candidates (written to the handoff ledger)",
			"preview.docs": "Handoff document",
			"preview.prompt": "Prompt for the new session (editable)",
			"preview.refs": "Reference files (rebuilds the prompt; locked after manual edits)",
			"preview.refsLocked": "The prompt was edited manually, so reference toggles are locked. Regenerate to change them.",
			"preview.open": "Open new session",
			"preview.copy": "Copy prompt",
			"preview.regen": "Regenerate",
			"preview.close": "Close",
			"preview.opening": "Opening…",
			"preview.regenerating": "Regenerating…",
			"preview.copied": "Prompt copied",
			"preview.copyPath": "Copy document path",
			"preview.pathCopied": "Document path copied",
			"preview.degraded": "Degraded output: ",
			"preview.emptyRefs": "(no reference files detected)",
			"preview.sent": "Sent to the new session: ",
			"preview.draft": "Prefilled the new session: ",
			"preview.failed": "Failed to open a new session: ",
			"preview.regenFailed": "Regeneration failed: "
		};
		function language$1() {
			return (typeof navigator === "undefined" ? "" : String(navigator.language ?? "")).toLowerCase().startsWith("zh") ? "zh" : "en";
		}
		/** 可编辑预览卡；没有载荷时渲染 null。 */
		function PreviewCard({ t, open, regenerate, copy, close }) {
			const state = (0, react.useSyncExternalStore)(previewStore.subscribe, previewStore.getState, previewStore.getState);
			const payload = state.phase === "ready" ? state.payload : void 0;
			const [prompt, setPrompt] = (0, react.useState)("");
			const [refs, setRefs] = (0, react.useState)([]);
			const [edited, setEdited] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				if (payload === void 0) return;
				setPrompt(payload.promptText);
				setRefs([...payload.promptParts.references]);
				setEdited(false);
				setError("");
			}, [payload]);
			const requestClose = (0, react.useCallback)(() => {
				if (busy !== null) return;
				close?.();
			}, [busy, close]);
			(0, react.useEffect)(() => {
				if (payload === void 0) return void 0;
				const onKey = (event) => {
					if (event.key === "Escape") requestClose();
				};
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("keydown", onKey);
				};
			}, [payload, requestClose]);
			const text = (0, react.useCallback)((key) => {
				const translated = typeof t === "function" ? t(key) : void 0;
				if (typeof translated === "string" && translated !== "" && translated !== key) return translated;
				return (language$1() === "zh" ? ZH$1 : EN$1)[key] ?? key;
			}, [t]);
			if (payload === void 0) return null;
			const toggleRef = (file) => {
				if (edited) return;
				const set = new Set(refs);
				if (set.has(file)) set.delete(file);
				else set.add(file);
				const next = payload.promptParts.referenceOptions.filter((option) => set.has(option));
				setRefs(next);
				setPrompt(composePrompt(payload.promptParts, next));
			};
			const onOpen = async () => {
				if (busy !== null || open === void 0) return;
				setBusy("open");
				setError("");
				try {
					const mode = await open(prompt);
					toast(`${text(mode === "sent" ? "preview.sent" : "preview.draft")}${payload.title}`);
					close?.();
				} catch (cause) {
					setError(`${text("preview.failed")}${cause instanceof Error ? cause.message : String(cause)}`);
				} finally {
					setBusy(null);
				}
			};
			const onRegenerate = async () => {
				if (busy !== null || regenerate === void 0) return;
				setBusy("regen");
				setError("");
				try {
					await regenerate();
				} catch (cause) {
					setError(`${text("preview.regenFailed")}${cause instanceof Error ? cause.message : String(cause)}`);
				} finally {
					setBusy(null);
				}
			};
			const onCopy = async (value, doneKey) => {
				try {
					if (copy !== void 0) await copy(value);
					toast(text(doneKey));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			const header = (0, react.createElement)("div", { className: CLS.cardHead }, (0, react.createElement)("h2", null, payload.title), (0, react.createElement)("span", { className: CLS.meta }, payload.sessionId), (0, react.createElement)("button", {
				type: "button",
				className: CLS.action,
				onClick: requestClose,
				disabled: busy !== null,
				title: text("preview.close")
			}, "✕"));
			const bodyChildren = [
				(0, react.createElement)("div", {
					key: "summary",
					className: CLS.summary
				}, payload.promptParts.summary),
				payload.promptParts.nextSteps.length > 0 ? (0, react.createElement)("div", { key: "next" }, (0, react.createElement)("div", { className: CLS.label }, text("preview.next")), (0, react.createElement)("ol", { className: CLS.candidates }, payload.promptParts.nextSteps.slice(0, 6).map((step, index) => (0, react.createElement)("li", { key: index }, step.step)))) : null,
				payload.memoryCandidates.length > 0 ? (0, react.createElement)("div", { key: "memory" }, (0, react.createElement)("div", { className: CLS.label }, text("preview.memory")), (0, react.createElement)("ul", { className: CLS.candidates }, payload.memoryCandidates.map((candidate, index) => (0, react.createElement)("li", { key: index }, `[${candidate.scope}] ${candidate.text}`)))) : null,
				(0, react.createElement)("div", { key: "docs" }, (0, react.createElement)("div", { className: CLS.label }, text("preview.docs")), (0, react.createElement)("div", { className: CLS.meta }, payload.docPath), (0, react.createElement)("button", {
					type: "button",
					className: CLS.action,
					onClick: () => {
						onCopy(payload.docPath, "preview.pathCopied");
					}
				}, text("preview.copyPath"))),
				payload.degraded.length > 0 ? (0, react.createElement)("div", {
					key: "degraded",
					className: CLS.meta
				}, `${text("preview.degraded")}${payload.degraded.join("; ")}`) : null,
				(0, react.createElement)("div", { key: "prompt" }, (0, react.createElement)("div", { className: CLS.label }, text("preview.prompt")), (0, react.createElement)("textarea", {
					className: CLS.prompt,
					value: prompt,
					spellCheck: false,
					autoFocus: true,
					"aria-label": text("preview.prompt"),
					onChange: (event) => {
						setPrompt(event.target.value);
						setEdited(true);
					}
				})),
				(0, react.createElement)("div", { key: "refs" }, (0, react.createElement)("div", { className: CLS.label }, text("preview.refs")), edited ? (0, react.createElement)("div", { className: CLS.meta }, text("preview.refsLocked")) : null, payload.promptParts.referenceOptions.length === 0 ? (0, react.createElement)("div", { className: CLS.meta }, text("preview.emptyRefs")) : (0, react.createElement)("div", { className: CLS.refs }, payload.promptParts.referenceOptions.map((file) => (0, react.createElement)("label", {
					key: file,
					className: CLS.ref,
					"data-disabled": String(edited)
				}, (0, react.createElement)("input", {
					type: "checkbox",
					checked: refs.includes(file),
					disabled: edited,
					onChange: () => {
						toggleRef(file);
					}
				}), (0, react.createElement)("span", { title: file }, file))))),
				error !== "" ? (0, react.createElement)("div", {
					key: "error",
					className: CLS.error,
					role: "alert"
				}, error) : null
			];
			const footer = (0, react.createElement)("div", { className: CLS.cardFoot }, (0, react.createElement)("div", { className: CLS.actions }, (0, react.createElement)("button", {
				type: "button",
				className: CLS.action,
				onClick: requestClose,
				disabled: busy !== null
			}, text("preview.close")), (0, react.createElement)("button", {
				type: "button",
				className: CLS.action,
				onClick: () => {
					onCopy(prompt, "preview.copied");
				},
				disabled: busy !== null
			}, text("preview.copy")), (0, react.createElement)("button", {
				type: "button",
				className: CLS.action,
				onClick: () => {
					onRegenerate();
				},
				disabled: busy !== null || regenerate === void 0
			}, busy === "regen" ? spinner() : text("preview.regen")), (0, react.createElement)("button", {
				type: "button",
				className: CLS.actionPrimary,
				onClick: () => {
					onOpen();
				},
				disabled: busy !== null || open === void 0
			}, busy === "open" ? spinner() : text("preview.open"))));
			return (0, react.createElement)("div", {
				className: CLS.backdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) requestClose();
				}
			}, (0, react.createElement)("div", {
				className: CLS.card,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": text("preview.title")
			}, header, (0, react.createElement)("div", { className: CLS.cardBody }, bodyChildren), footer));
		}
		// src/client/index.ts
		/**
		* dsh-session-handoff 浏览器半入口。
		*
		* 三个入口共用一条链路：
		*   1. 输入框右侧「接力」按钮（conversation.input.right）
		*   2. 快捷键 Cmd/Ctrl+Shift+H（ctx.shortcuts）
		*   3. 生成后的可编辑预览卡（shell.overlay）
		*
		* 链路：请求宿主生成交接包 → 默认打开预览卡（可编辑提示词/勾选参考文件）→
		* 用户确认后打开同工作区新会话；`preview: false` 时退回 v0.1 的直接草稿/发送。
		*
		* @module dsh-session-handoff/client
		*/
		const NS = "handoff";
		const API_PREPARE = "/session-handoff/prepare";
		/** 浏览器半只要求 slots；其余服务按可选读取。 */
		const inject = ["slots"];
		const ZH = {
			"action.label": "接力到新会话",
			"action.aria": "总结当前会话并打开新会话继续",
			"action.busy": "正在整理交接…",
			"toast.preview": "已生成交接预览，确认后打开新会话",
			"toast.draft": "已生成交接文档，新会话已预填提示词：",
			"toast.sent": "已生成交接文档并发送到新会话：",
			"toast.failed": "会话接力失败：",
			"shortcut.label": "会话接力"
		};
		const EN = {
			"action.label": "Hand off to a new session",
			"action.aria": "Summarize this session and continue in a new one",
			"action.busy": "Preparing handoff…",
			"toast.preview": "Handoff preview ready — confirm to open a new session",
			"toast.draft": "Handoff written; the new session is prefilled: ",
			"toast.sent": "Handoff written and sent to the new session: ",
			"toast.failed": "Handoff failed: ",
			"shortcut.label": "Session handoff"
		};
		function language() {
			return (typeof navigator === "undefined" ? "" : String(navigator.language ?? "")).toLowerCase().startsWith("zh") ? "zh" : "en";
		}
		function softGet(ctx, name) {
			if (typeof ctx.get === "function") try {
				const resolved = ctx.get(name, false);
				if (resolved !== void 0 && resolved !== null) return resolved;
			} catch {}
			try {
				return ctx[name];
			} catch {
				return;
			}
		}
		function errorMessage(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** shell.overlay 是否可用；不可用时预览退化为 v0.1 的直接打开。 */
		let overlayAvailable = false;
		/** 请求宿主生成交接包（不打开会话）。 */
		async function preparePayload(sessionId, hint = {}) {
			const response = await fetch(API_PREPARE, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-dsh-handoff": "1"
				},
				body: JSON.stringify({ sessionId })
			});
			const body = await response.json().catch(() => void 0);
			if (!response.ok || body === void 0 || body.ok !== true) {
				const detail = body?.message ?? `HTTP ${response.status}`;
				if (response.status === 404) throw new Error(`${detail}（宿主端点未注册：确认插件宿主半已启用）`);
				throw new Error(detail);
			}
			if (typeof body.promptText !== "string" || body.promptParts === void 0) throw new Error("宿主返回缺少 promptParts/promptText（插件宿主半与浏览器半版本不匹配？）");
			return {
				preview: body.preview !== false,
				payload: {
					sessionId,
					title: typeof body.title === "string" ? body.title : "会话交接",
					promptText: body.promptText,
					promptParts: body.promptParts,
					docPath: typeof body.docPath === "string" ? body.docPath : "",
					dataPath: typeof body.dataPath === "string" ? body.dataPath : "",
					...typeof body.memoryPath === "string" ? { memoryPath: body.memoryPath } : {},
					memoryCandidates: Array.isArray(body.memoryCandidates) ? body.memoryCandidates : [],
					degraded: Array.isArray(body.degraded) ? body.degraded : [],
					autoSend: body.autoSend === true,
					hint
				}
			};
		}
		/** 生成 → 预览 / 直接打开；返回最终方式。 */
		async function trigger(ctx, sessionId, hint = {}) {
			previewStore.set({ phase: "preparing" });
			try {
				const { payload, preview } = await preparePayload(sessionId, hint);
				if (preview && overlayAvailable) {
					previewStore.set({
						phase: "ready",
						payload
					});
					return { mode: "preview" };
				}
				const mode = await openWithPrompt(ctx, payload.promptText, payload.autoSend, hint);
				previewStore.idle();
				return { mode };
			} catch (cause) {
				previewStore.idle();
				throw cause;
			}
		}
		/** 按钮：紧凑图标 + 悬停说明；生成中显示转圈，完成态短暂打勾变绿。 */
		function HandoffButton({ sessionId, t, run, useWorkspaces, useSession }) {
			const state = (0, react.useSyncExternalStore)(previewStore.subscribe, previewStore.getState, previewStore.getState);
			const latch = useDoneLatch();
			const workspaceId = typeof useWorkspaces === "function" ? useWorkspaces((snapshot) => {
				const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
				for (const item of items) if (Array.isArray(item.sessionIds) && sessionId !== void 0 && item.sessionIds.includes(sessionId)) return item.workspaceId;
			}) : void 0;
			const cwd = typeof useSession === "function" ? useSession((snapshot) => typeof snapshot?.cwd === "string" ? snapshot.cwd : void 0) : void 0;
			const hint = {
				...typeof workspaceId === "string" ? { workspaceId } : {},
				...typeof cwd === "string" ? { cwd } : {}
			};
			(0, react.useEffect)(() => {
				if (sessionId !== void 0) activeSession.set(sessionId, hint);
			}, [
				sessionId,
				hint.workspaceId,
				hint.cwd
			]);
			const text = (0, react.useCallback)((key) => {
				const translated = typeof t === "function" ? t(key) : void 0;
				if (typeof translated === "string" && translated !== "" && translated !== key) return translated;
				return (language() === "zh" ? ZH : EN)[key] ?? key;
			}, [t]);
			const busy = state.phase === "preparing";
			const onClick = (0, react.useCallback)(() => {
				if (busy || sessionId === void 0 || run === void 0) return;
				(async () => {
					try {
						const result = await run(sessionId, hint);
						latch.succeed();
						if (result.mode === "preview") {
							const current = previewStore.getState();
							toast(`${text("toast.preview")}${current.phase === "ready" ? `：${current.payload.title}` : ""}`);
						} else if (result.mode === "sent") toast(text("toast.sent"));
						else toast(text("toast.draft"));
					} catch (cause) {
						latch.fail();
						toast(`${text("toast.failed")}${errorMessage(cause)}`, "error");
					}
				})();
			}, [
				busy,
				hint,
				latch,
				run,
				sessionId,
				text
			]);
			const title = busy ? text("action.busy") : text("action.label");
			return (0, react.createElement)("button", {
				type: "button",
				className: CLS.button,
				title,
				"aria-label": text("action.aria"),
				"aria-busy": busy,
				"data-busy": String(busy),
				"data-done": String(latch.done),
				"data-error": String(latch.error),
				disabled: busy,
				onClick,
				onMouseDown: (event) => {
					event.preventDefault?.();
				}
			}, busy ? spinner() : handoffIcon(16));
		}
		/** 注册按钮座位；返回是否成功。 */
		function registerButton(ctx, canLocale, run) {
			for (const seat of ["conversation.input.right", "conversation.session.header.utilities"]) try {
				ctx.slots.inject(seat, () => {
					try {
						return ctx.slots.register({
							name: seat,
							id: "dsh-session-handoff",
							order: 40,
							...canLocale ? { locale: NS } : {},
							inject: () => ({ run })
						}, HandoffButton);
					} catch (cause) {
						console.warn(`[dsh-session-handoff] 按钮注册失败（其他条目不受影响）：${errorMessage(cause)}`);
						return;
					}
				});
				return true;
			} catch (cause) {
				console.warn(`[dsh-session-handoff] 座位 ${seat} 不可用：${errorMessage(cause)}`);
			}
			return false;
		}
		/** 注册预览卡（root 作用域的 shell.overlay）。 */
		function registerPreview(ctx) {
			const face = {
				open: async (prompt) => {
					const state = previewStore.getState();
					if (state.phase !== "ready") throw new Error("没有待确认的交接预览");
					return await openWithPrompt(ctx, prompt, state.payload.autoSend, state.payload.hint);
				},
				regenerate: async () => {
					const state = previewStore.getState();
					if (state.phase !== "ready") return;
					await trigger(ctx, state.payload.sessionId, state.payload.hint);
				},
				copy: copyText,
				close: () => {
					previewStore.idle();
				}
			};
			try {
				ctx.slots.inject("shell.overlay", () => {
					try {
						return ctx.slots.register({
							name: "shell.overlay",
							id: "dsh-session-handoff-preview",
							order: 900,
							inject: () => face
						}, PreviewCard);
					} catch (cause) {
						console.warn(`[dsh-session-handoff] 预览卡注册失败（其他条目不受影响）：${errorMessage(cause)}`);
						return;
					}
				});
				return true;
			} catch (cause) {
				console.warn(`[dsh-session-handoff] 预览座位 shell.overlay 不可用：${errorMessage(cause)}`);
				return false;
			}
		}
		/** 注册快捷键：Cmd/Ctrl+Shift+H。 */
		function registerShortcut(ctx) {
			const shortcuts = softGet(ctx, "shortcuts");
			if (shortcuts === void 0 || typeof shortcuts.register !== "function" || typeof ctx.effect !== "function") return false;
			const modifiers = ["primary", "shift"];
			const command = {
				id: "session.handoff",
				label: () => language() === "zh" ? ZH["shortcut.label"] : EN["shortcut.label"],
				aliases: [
					"handoff",
					"session handoff",
					"会话接力",
					"新会话接力"
				],
				defaults: {
					"desktop:macos": {
						code: "KeyH",
						modifiers
					},
					"desktop:windows": {
						code: "KeyH",
						modifiers
					},
					"desktop:linux": {
						code: "Period",
						modifiers
					},
					"web:macos": {
						code: "KeyH",
						modifiers
					},
					"web:windows": {
						code: "KeyH",
						modifiers
					},
					"web:linux": {
						code: "Period",
						modifiers
					}
				},
				regions: ["page", "editable"],
				modals: [],
				resolve: () => {
					const active = activeSession.get();
					if (active === void 0) return {
						status: "blocked",
						reason: language() === "zh" ? "没有可接力的会话" : "No session to hand off"
					};
					return {
						status: "handled",
						run: () => {
							trigger(ctx, active.sessionId, active.hint).catch((cause) => {
								toast(`${language() === "zh" ? ZH["toast.failed"] : EN["toast.failed"]}${errorMessage(cause)}`, "error");
							});
						}
					};
				}
			};
			try {
				ctx.effect(() => shortcuts.register(command), "dsh-session-handoff: shortcut");
				return true;
			} catch (cause) {
				console.warn(`[dsh-session-handoff] 快捷键注册失败：${errorMessage(cause)}`);
				return false;
			}
		}
		/** 插件入口。 */
		function apply(ctx) {
			ensureStyles();
			overlayAvailable = registerPreview(ctx);
			const run = (sessionId, hint) => trigger(ctx, sessionId, hint);
			registerShortcut(ctx);
			const locale = softGet(ctx, "locale");
			const canLocale = locale !== void 0 && typeof locale.register === "function" && typeof ctx.effect === "function";
			if (canLocale && typeof ctx.effect === "function") try {
				ctx.effect(() => locale.register(NS, {
					zh: ZH,
					en: EN
				}), "dsh-session-handoff: dictionaries");
			} catch (cause) {
				console.warn(`[dsh-session-handoff] 词典注册失败，使用内置文案：${errorMessage(cause)}`);
			}
			const registered = registerButton(ctx, canLocale, run);
			console.log(`[dsh-session-handoff] 浏览器半已加载（按钮${registered ? "已注册" : "未找到"}；预览${overlayAvailable ? "可用" : "不可用，退回直接打开"}）`);
		}
		/** 供测试/二次开发引用：内部座位 id。 */
		const SEAT_ID = "dsh-session-handoff";
		/** 测试用只读探针（不参与运行时 UI）。 */
		const __testing = {
			previewStore,
			activeSession,
			trigger
		};
		exports.SEAT_ID = SEAT_ID;
		exports.__testing = __testing;
		exports.apply = apply;
		exports.composePrompt = composePrompt;
		exports.inject = inject;
		return module.exports;
	}
});
