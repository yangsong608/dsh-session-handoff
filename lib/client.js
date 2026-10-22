window.__ModuleLoader__.load({
	id: "dsh-session-handoff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
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
			toastError: "dsh-handoff-toast-error"
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
		// src/client/index.ts
		/**
		* dsh-session-handoff 浏览器半：在输入框右侧工具行、提交按钮之前放一个「接力」按钮。
		*
		* 一次点击完成：请求宿主生成交接包 → 在（同一工作区的）新会话里预填交接提示词
		* → 打开新会话。默认是「预填草稿」，用户可以在发送前审阅；配置 autoSend 时
		* 走 sessions.retain + prompt 直接发出（能力缺失会自动回退到草稿）。
		*
		* 座位：conversation.input.right（list / session，注册前为空）。若该座位在某个
		* DSH 版本被移除，退回 conversation.session.header.utilities；两者都没有时插件
		* 的浏览器半保持静默（宿主能力仍可用）。
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
			"toast.draft": "已生成交接文档，新会话已预填提示词：",
			"toast.sent": "已生成交接文档并发送到新会话：",
			"toast.failed": "会话接力失败：",
			"toast.no-session": "没有可接力的会话"
		};
		const EN = {
			"action.label": "Hand off to a new session",
			"action.aria": "Summarize this session and continue in a new one",
			"action.busy": "Preparing handoff…",
			"toast.draft": "Handoff written; the new session is prefilled: ",
			"toast.sent": "Handoff written and sent to the new session: ",
			"toast.failed": "Handoff failed: ",
			"toast.no-session": "No session to hand off"
		};
		function detectLanguage() {
			return (typeof navigator === "undefined" ? "" : String(navigator.language ?? "")).toLowerCase().startsWith("zh") ? "zh" : "en";
		}
		function softGet(ctx, name) {
			if (typeof ctx.get !== "function") return void 0;
			try {
				return ctx.get(name, false);
			} catch {
				return;
			}
		}
		function errorMessage(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** 把交接提示词写进新会话；返回发送方式。 */
		async function openWithPrompt(ctx, promptText, autoSend, hint = {}) {
			const nav = softGet(ctx, "uiWorkspace");
			const sessions = softGet(ctx, "sessions");
			if (autoSend && sessions !== void 0 && typeof sessions.create === "function" && nav?.openSession !== void 0) try {
				const created = await sessions.create(hint.workspaceId !== void 0 ? { workspaceId: hint.workspaceId } : hint.cwd !== void 0 ? { cwd: hint.cwd } : {});
				const sessionId = String(created ?? "");
				if (sessionId === "") throw new Error("sessions.create 未返回会话 id");
				await sendToSession(sessions, sessionId, promptText);
				nav.openSession(sessionId);
				return "sent";
			} catch (cause) {
				toast(`自动发送失败，改为预填草稿（${errorMessage(cause)}）`, "error");
			}
			if (nav !== void 0 && typeof nav.startSession === "function") {
				nav.startSession(hint.workspaceId, { prompt: promptText });
				return "draft";
			}
			if (sessions !== void 0 && typeof sessions.create === "function") {
				const sessionId = String(await sessions.create(hint.workspaceId !== void 0 ? { workspaceId: hint.workspaceId } : hint.cwd !== void 0 ? { cwd: hint.cwd } : {}) ?? "");
				if (sessionId === "") throw new Error("sessions.create 未返回会话 id");
				await sendToSession(sessions, sessionId, promptText);
				const open = softGet(ctx, "uiWorkspace")?.openSession;
				open?.(sessionId);
				return "sent";
			}
			throw new Error("当前 DSH 缺少创建会话的入口（uiWorkspace.startSession / sessions.create）");
		}
		/** 通过 sessions.retain 拿到已绑定会话再入队一轮（能力缺失时抛出）。 */
		async function sendToSession(sessions, sessionId, text) {
			if (typeof sessions.retain !== "function") throw new Error("缺少 sessions.retain");
			const ref = sessions.retain(sessionId, { source: "handoff" });
			try {
				await Promise.race([Promise.resolve(ref.ready).catch(() => void 0), new Promise((_, reject) => {
					setTimeout(() => reject(/* @__PURE__ */ new Error("会话打开超时")), 1e4);
				})]);
				const session = ref.binding?.session;
				if (session === void 0 || typeof session.prompt !== "function") throw new Error("会话不可用");
				const result = await session.prompt([{
					type: "text",
					text
				}], "queue");
				if (result !== void 0 && result.ok === false) throw new Error(result.error?.message ?? "发送失败");
			} finally {
				ref.release?.();
			}
		}
		/** 请求宿主生成交接包，并打开新会话。 */
		async function requestHandoff(ctx, sessionId, hint = {}) {
			const response = await fetch(API_PREPARE, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-dsh-handoff": "1"
				},
				body: JSON.stringify({ sessionId })
			});
			const body = await response.json().catch(() => void 0);
			if (!response.ok || body === void 0 || body.ok !== true || typeof body.promptText !== "string") {
				const detail = body?.message ?? `HTTP ${response.status}`;
				if (response.status === 404) throw new Error(`${detail}（宿主端点未注册：确认插件宿主半已启用）`);
				throw new Error(detail);
			}
			const mode = await openWithPrompt(ctx, body.promptText, body.autoSend === true, hint);
			return {
				title: typeof body.title === "string" ? body.title : "会话交接",
				mode
			};
		}
		/** 按钮：紧凑图标 + 悬停说明；生成中显示转圈，完成态短暂打勾变绿。 */
		function HandoffButton({ sessionId, t, run, useWorkspaces, useSession }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const workspaceId = typeof useWorkspaces === "function" ? useWorkspaces((snapshot) => {
				const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
				for (const item of items) if (Array.isArray(item.sessionIds) && sessionId !== void 0 && item.sessionIds.includes(sessionId)) return item.workspaceId;
			}) : void 0;
			const cwd = typeof useSession === "function" ? useSession((snapshot) => typeof snapshot?.cwd === "string" ? snapshot.cwd : void 0) : void 0;
			const latch = useDoneLatch();
			const text = (0, react.useCallback)((key) => {
				const translated = typeof t === "function" ? t(key) : void 0;
				if (typeof translated === "string" && translated !== "" && translated !== key) return translated;
				return (detectLanguage() === "zh" ? ZH : EN)[key] ?? key;
			}, [t]);
			const onClick = (0, react.useCallback)(() => {
				if (busy || sessionId === void 0) return;
				setBusy(true);
				(async () => {
					try {
						if (run === void 0) throw new Error("注入面缺失");
						const result = await run(sessionId, {
							...typeof workspaceId === "string" ? { workspaceId } : {},
							...typeof cwd === "string" ? { cwd } : {}
						});
						latch.succeed();
						toast(`${text(result.mode === "sent" ? "toast.sent" : "toast.draft")}${result.title}`);
					} catch (cause) {
						latch.fail();
						toast(`${text("toast.failed")}${errorMessage(cause)}`, "error");
					} finally {
						setBusy(false);
					}
				})();
			}, [
				busy,
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
			const options = {
				name: "conversation.input.right",
				id: "session-handoff",
				order: 40,
				...canLocale ? { locale: NS } : {},
				inject: () => ({ run })
			};
			for (const seat of ["conversation.input.right", "conversation.session.header.utilities"]) try {
				ctx.slots.inject(seat, () => ctx.slots.register(seat === "conversation.input.right" ? options : {
					...options,
					name: seat
				}, HandoffButton));
				return true;
			} catch (cause) {
				console.warn(`[dsh-session-handoff] 座位 ${seat} 不可用：${errorMessage(cause)}`);
			}
			return false;
		}
		/** 插件入口。 */
		function apply(ctx) {
			ensureStyles();
			const run = (sessionId, hint) => requestHandoff(ctx, sessionId, hint);
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
			console.log(`[dsh-session-handoff] 浏览器半已加载（按钮座位${registered ? "已注册" : "未找到，保持静默"}）`);
		}
		exports.SEAT_ID = "session-handoff";
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
