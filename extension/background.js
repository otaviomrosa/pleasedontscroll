// background.js

let settings = {
  instagramBlocked: false,
  tiktokBlocked: false,
  youtubeBlocked: false
};

function isHostMatch(url, host) {
  try {
    const u = new URL(url);
    return u.hostname === host || u.hostname.endsWith('.' + host);
  } catch (e) {
    return false;
  }
}

async function checkAndBlockTab(tabId, url) {
  if (!url) return;
  if (url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file:')) return;

  // Logic simplified: Check strictly if the platform is blocked in settings
  const shouldBlockInstagram = settings.instagramBlocked && (isHostMatch(url, 'instagram.com') || isHostMatch(url, 'www.instagram.com'));
  const shouldBlockTiktok = settings.tiktokBlocked && (isHostMatch(url, 'tiktok.com') || isHostMatch(url, 'www.tiktok.com'));
  const shouldBlockYoutube = settings.youtubeBlocked && (isHostMatch(url, 'youtube.com') || isHostMatch(url, 'www.youtube.com') || isHostMatch(url, 'youtu.be'));

  if (shouldBlockInstagram || shouldBlockTiktok || shouldBlockYoutube) {
    const blockedUrl = chrome.runtime.getURL('blocked.html');
    try {
      await chrome.tabs.update(tabId, { url: blockedUrl });
      console.log('Blocked tab', tabId, '->', blockedUrl);
    } catch (e) {
      console.warn('Failed to redirect tab', tabId, e);
    }
  }
}

// Listen for tab updates (navigation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    checkAndBlockTab(tabId, changeInfo.url);
  } else if (changeInfo.status === 'complete') {
    checkAndBlockTab(tabId, tab.url);
  }
});

// Also check when tabs are switched/activated
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    checkAndBlockTab(tab.id, tab.url);
  } catch (e) {
    // ignore
  }
});

// React to settings changes in real-time
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let dirty = false;
  for (const key in changes) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      settings[key] = changes[key].newValue;
      dirty = true;
    }
  }

  if (dirty) {
    // If settings changed, re-check all open tabs immediately
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        checkAndBlockTab(t.id, t.url);
      }
    });
  }
});

// Load initial settings on startup
chrome.storage.sync.get(['instagramBlocked', 'tiktokBlocked', 'youtubeBlocked'], (result) => {
  settings.instagramBlocked = result.instagramBlocked || false;
  settings.tiktokBlocked = result.tiktokBlocked || false;
  settings.youtubeBlocked = result.youtubeBlocked || false;

  // Check existing tabs on browser launch
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      checkAndBlockTab(t.id, t.url);
    }
  });
});