// Clicking the toolbar button (or pressing Alt+Shift+S) injects the picker into the current tab.
const FILES = ['content/capture.js', 'content/render.js', 'content/overlay.js'];
const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;

async function start(tab) {
  const target = { tabId: tab.id };
  try {
    const [{ result: ready }] = await chrome.scripting.executeScript({
      target,
      func: () => !!globalThis.Webshots?.toggle,
    });
    if (!ready) await chrome.scripting.executeScript({ target, files: FILES });
    await chrome.scripting.executeScript({ target, func: () => globalThis.Webshots.toggle() });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    await chrome.action.setTitle({ tabId: tab.id, title: DEFAULT_TITLE });
  } catch (err) {
    // Browser pages (edge://, chrome://), the add-ons store and the PDF viewer can't be scripted
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d93025' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: `Webshots can't capture this page: ${err.message}` });
  }
}

chrome.action.onClicked.addListener(start);
