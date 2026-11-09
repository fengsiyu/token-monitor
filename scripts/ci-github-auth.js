'use strict';

// GitHub's anonymous release-download gateway can return 504 during traffic
// surges (see githubstatus incidents), while authenticated requests are
// unaffected. Patch global fetch so every github.com download in the build
// carries the Actions-provided GITHUB_TOKEN. This covers @electron/get
// (electron, appimagetool, 7zip) and the vendored tokscale downloader in one
// place rather than relying on each tool to authenticate on its own.

function applyGithubAuth(token, targetFetch = globalThis.fetch) {
  if (!token) return targetFetch;
  const patched = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (typeof url === 'string' && url.startsWith('https://github.com/')) {
      const headers = new Headers(init.headers);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      init = { ...init, headers };
    }
    return targetFetch(input, init);
  };
  return patched;
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (token) globalThis.fetch = applyGithubAuth(token);

module.exports = { applyGithubAuth };
