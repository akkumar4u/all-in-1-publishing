const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceRoot = path.join(__dirname, '..', 'src');

function parseGoogleDoc(type, sourceHtml, ownHost = '') {
  const { JSDOM } = require('jsdom');
  const scripts = {
    links: fs.readFileSync(path.join(sourceRoot, 'link_rules.js'), 'utf8'),
    hub: fs.readFileSync(path.join(sourceRoot, 'hub_parser.js'), 'utf8'),
    blog: fs.readFileSync(path.join(sourceRoot, 'blog_parser.js'), 'utf8'),
  };
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const window = dom.window;
  const sandbox = {
    DOMParser: window.DOMParser,
    NodeFilter: window.NodeFilter,
    document: window.document,
    URL,
    console,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    __diOwnHost: String(ownHost || ''),
    __sourceHtml: sourceHtml,
  };
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(scripts.links, context, { filename: 'link_rules.js', timeout: 3000 });
    vm.runInContext(scripts[type], context, { filename: `${type}_parser.js`, timeout: 5000 });
    const expression = type === 'hub' ? 'parseComparisonDoc(__sourceHtml)' : 'parseGoogleDoc(__sourceHtml)';
    const result = vm.runInContext(expression, context, { timeout: 5000 });
    return JSON.parse(JSON.stringify(result));
  } finally {
    window.close();
  }
}

module.exports = { parseGoogleDoc };
