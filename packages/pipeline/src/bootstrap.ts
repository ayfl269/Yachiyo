import "./stages/waking-check.js";
import "./stages/session-status-check.js";
import "./stages/rate-limit.js";
import "./stages/content-safety-check.js";
import "./stages/preprocess.js";
import "./stages/process.js";
import "./stages/result-decorate.js";
import "./stages/respond.js";

let builtinStagesRegistered = false;

export function ensureBuiltinStagesRegistered(): void {
  builtinStagesRegistered = true;
}

export function isBuiltinStagesRegistered(): boolean {
  return builtinStagesRegistered;
}

