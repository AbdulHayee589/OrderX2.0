export function isMetaCallbackForActiveState(
  activeState,
  callbackState,
  { allowMissingCallbackState = false } = {},
) {
  const active = String(activeState || "").trim();
  const callback = String(callbackState || "").trim();
  if (!active) return false;
  if (!callback) return allowMissingCallbackState;
  return callback === active;
}
