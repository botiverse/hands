/**
 * Scalar 1.76.4 has a few hard-coded English labels outside its localization
 * catalogue. Restrict these replacements to its own controls, not API examples
 * or descriptions. Keep the CDN version pinned and exercise this in a browser
 * when upgrading Scalar; remove the patch once upstream localizes them.
 */
export const scalarChineseLabels = `
(function () {
  const replacements = {
    'Open Group': '打开分组',
    'Close Group': '关闭分组',
    'HTTP Method:': 'HTTP 方法：',
    'Path:': '路径：',
    'Description:': '说明：'
  };
  function update() {
    document.querySelectorAll('#app button .sr-only, [role="dialog"] button .sr-only').forEach(function (el) {
      const label = el.textContent.trim();
      if (Object.prototype.hasOwnProperty.call(replacements, label)) el.textContent = replacements[label];
    });
    document.querySelectorAll('.request-card .scalar-card-header-title > .sr-only').forEach(function (el) {
      if (el.textContent.trim() === 'Request Example for') el.textContent = '请求示例：';
    });
    document.querySelectorAll('button.scalar-code-copy').forEach(function (button) {
      const label = button.getAttribute('aria-label') || '';
      const match = /^Copy(?: (.+))? code$/.exec(label);
      if (match) button.setAttribute('aria-label', match[1] ? '复制 ' + match[1] + ' 代码' : '复制代码');
      button.querySelectorAll('span').forEach(function (span) {
        if (span.children.length === 0 && span.textContent.trim() === 'Copy') span.textContent = '复制';
        if (span.children.length === 0 && span.textContent.trim() === 'Copied') span.textContent = '已复制';
      });
    });
    document.querySelectorAll('[role="group"][aria-label="Code sample"]').forEach(function (el) { el.setAttribute('aria-label', '代码示例'); });
    document.querySelectorAll('.toggle-icon-light[aria-label="Set dark mode"]').forEach(function (el) { el.setAttribute('aria-label', '切换为深色模式'); });
    document.querySelectorAll('.toggle-icon-dark[aria-label="Set light mode"]').forEach(function (el) { el.setAttribute('aria-label', '切换为浅色模式'); });
    document.querySelectorAll('section[aria-label="Notifications alt+T"]').forEach(function (el) { el.setAttribute('aria-label', '通知 Alt+T'); });
  }
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; update(); });
  }
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
  schedule();
})();`;
