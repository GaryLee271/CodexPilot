  async function readCodexAppServerPreparation(path, payload, timeoutMs = codexAppServerPreparationTimeoutMs) {
    let timeoutId;
    try {
      return await Promise.race([
        postJson(path, payload),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            sendCodexPlusDiagnostic("app_server_preparation_read_timeout", { path, timeoutMs });
            reject(new Error(`Codex Pilot preparation read timed out: ${path}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function loadBackendSettingsState(timeoutMs = 0) {
    const seq = codexPlusBackendSettingsSeq;
    try {
      const settings = await (timeoutMs > 0
        ? readCodexAppServerPreparation("/settings/get", {}, timeoutMs)
        : postJson("/settings/get", {}));
      if (!settings || typeof settings !== "object" || !("enhancementsEnabled" in settings)) {
        throw new Error("invalid backend settings response");
      }
      if (seq !== codexPlusBackendSettingsSeq) {
        return false;
      }
      codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
      codexPlusBackendSettingsLoaded = true;
      globalThis.window?.__codexPlusNativeFastUnlock?.runtime?.update?.({
        enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
        codexAppNativeFastUnlock: codexPlusBackendSettings.codexAppNativeFastUnlock === true,
        nativeFastLocalApiConfigured: codexPlusBackendSettings.nativeFastLocalApiConfigured === true,
      });
      // 分区只接收策略和已核验的本机账号标识，不接收认证或供应商凭据。
      globalThis.window?.__codexPlusNativeProjectSections?.runtime?.update?.({
        enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
        codexAppNativeProjectSections: codexPlusBackendSettings.codexAppNativeProjectSections === true,
        nativeProjectSectionsLocalApiConfigured: codexPlusBackendSettings.nativeProjectSectionsLocalApiConfigured === true,
      });
      // 原生输入预测只接收开关、本机 API 布尔投影和预测模型 ID。
      globalThis.window?.__codexPlusNativePredictions?.runtime?.update?.({
        enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
        codexAppNativePredictions: codexPlusBackendSettings.codexAppNativePredictions === true,
        nativePredictionsLocalApiConfigured: codexPlusBackendSettings.nativePredictionsLocalApiConfigured === true,
        codexAppNativePredictionsModel: String(codexPlusBackendSettings.codexAppNativePredictionsModel || "").trim(),
      });
    } catch (_) {
      return false;
    }
    return true;
  }
