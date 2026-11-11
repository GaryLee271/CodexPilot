/**
 * 侧栏底部统一提供 Codex 启动、重启和停止入口。
 * 状态和动作由 App 传入，沿用现有后端运行控制流程。
 */
import { Loader2, Play, Power, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "./i18n";

export type CodexLaunchState = {
  /** Codex 应用正在运行：按钮变成「重启 Codex」。 */
  running: boolean;
  /** 启动 / 重启 / 停止流程进行中（App 的 launchPending）。 */
  busy: boolean;
  /** 不能启动的原因（例如没有找到 Codex 应用）；null 表示可以启动。 */
  unavailableReason: string | null;
  onLaunch: () => void;
  onRestart: () => void;
  onStop: () => void;
};

export function CodexLaunchButton({ state, size = "default", className = "" }: {
  state: CodexLaunchState;
  size?: "default" | "sm";
  className?: string;
}) {
  // 运行中仍然可以重启；只有还没启动、又找不到 Codex 时才置灰。
  const unavailable = !state.running && Boolean(state.unavailableReason);
  const label = state.busy ? t("处理中…") : state.running ? t("重启 Codex") : t("启动 Codex");
  const hint = unavailable
    ? state.unavailableReason ?? ""
    : state.running
      ? t("重启 Codex，让增强设置重新生效")
      : t("启动 Codex，并加载 Codex Pilot 的增强设置");
  return (
    // 置灰的按钮不响应鼠标（disabled:pointer-events-none），提示挂在外层，悬停时仍能看到原因。
    <span className={`codex-launch ${className}`.trim()} data-running={state.running} data-unavailable={unavailable}>
      {state.running ? (
        <Button
          disabled={state.busy}
          onClick={state.onStop}
          size={size}
          type="button"
          variant="outline"
        >
          <Power aria-hidden="true" />
          {t("停止 Codex")}
        </Button>
      ) : null}
      <span title={hint}>
        <Button
          className="codex-launch-button"
          disabled={state.busy || unavailable}
          onClick={state.running ? state.onRestart : state.onLaunch}
          size={size}
          title={hint}
          type="button"
          variant="default"
        >
          {state.busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : state.running ? <RotateCw aria-hidden="true" /> : <Play aria-hidden="true" />}
          {label}
        </Button>
      </span>
    </span>
  );
}
