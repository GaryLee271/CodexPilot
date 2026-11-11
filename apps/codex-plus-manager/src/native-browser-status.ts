export type BrowserConnection = {
  state: string;
  browsers: { family: string; headerEnabled: boolean | null; recognized?: boolean }[];
  failedChecks: number;
};

export type NativeBrowserDiagnostics = {
  compatibility: { state: string; detail: string };
  connection: BrowserConnection;
};

type Translate = (source: string) => string;

export function browserConnectionLabel(connection: BrowserConnection, t: Translate = source => source): string {
  switch (connection.state) {
    case "available": {
      const names = [...new Set(connection.browsers.map(browser =>
        browser.family === "edge" ? "Edge" : browser.family === "chrome" ? "Chrome" : ""))].filter(Boolean);
      return names.length ? `${names.join(" / ")} ${t("浏览器可用")}` : t("浏览器状态检测失败");
    }
    case "disconnected": return t("浏览器未连接");
    case "checking": return t("正在检测浏览器连接");
    case "unsupported": return t("此平台不支持浏览器连接检测");
    default: return t("浏览器状态检测失败");
  }
}

export function browserHeaderLabel(enabled: boolean | null, t: Translate = source => source): string {
  return enabled === true ? t("请求标识：已开启（扩展报告）")
    : enabled === false ? t("请求标识：已关闭（扩展报告）")
    : t("请求标识：扩展未提供状态");
}

/// 「扩展连上了，但这个版本不认识」与「扩展没连上」是两回事（issue #2209）：
/// 前者说明链路是通的、只是该扩展 ID 未登记，后者才是真的没连上。
/// 不区分会让用户把版本适配问题误判成扩展故障，往错误方向排查。
export function browserRecognizedSuffix(recognized: boolean | undefined, t: Translate = source => source): string {
  return recognized === false ? t("（扩展版本未登记）") : "";
}

export function nativeBrowserStatusLabel(state: string, t: Translate = source => source): string {
  switch (state) {
    case "disabled": return t("兼容选项未启用");
    case "not_started": return t("等待下次启动 Codex Pilot；保存设置不会自动重启");
    case "waiting_for_runtime": return t("等待原生插件生成运行时");
    case "prepared": return t("兼容服务文件已准备，等待原生工作进程加载");
    case "restored": return t("服务文件已恢复；扩展保留的请求标识不受此操作影响");
    case "runtime_unverified": return t("未应用旧版兼容补丁：当前运行时版本不匹配");
    case "blocked": return t("兼容补丁文件检查或恢复受阻，已保留文件");
    case "unsupported": return t("此平台未提供 Edge / Chrome 请求标识兼容补丁");
    case "stale": return t("状态已过期；需启动本版本 Codex Pilot 后重新检查");
    default: return t("无法读取兼容补丁状态");
  }
}
