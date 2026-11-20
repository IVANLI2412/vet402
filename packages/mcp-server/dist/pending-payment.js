/** In-process guard: one live authorization per resource URL until validBefore. */
const live = new Map();
export function hasLiveAuthorization(resource) {
    const row = live.get(resource);
    if (row === undefined)
        return false;
    const now = Math.floor(Date.now() / 1000);
    if (now >= row.validBefore) {
        live.delete(resource);
        return false;
    }
    return true;
}
export function rememberLiveAuthorization(resource, validBefore, nonce) {
    live.set(resource, { validBefore, nonce });
}
export function clearLiveAuthorization(resource) {
    live.delete(resource);
}
