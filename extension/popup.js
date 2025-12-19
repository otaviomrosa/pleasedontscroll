// popup.js

document.addEventListener('DOMContentLoaded', () => {
    const instagramToggle = document.getElementById('instagram-toggle');
    const tiktokToggle = document.getElementById('tiktok-toggle');
    const sessionToggle = document.getElementById('session-toggle');

    // 1. LOAD SAVED SETTINGS
    chrome.storage.sync.get(['instagramBlocked', 'tiktokBlocked', 'sessionActive'], (result) => {
        instagramToggle.checked = result.instagramBlocked || false;
        tiktokToggle.checked = result.tiktokBlocked || false;
        sessionToggle.checked = result.sessionActive || false;
    });

    // 2. SAVE SETTINGS when session toggle changes
    sessionToggle.addEventListener('change', () => {
        const isInstagramBlocked = instagramToggle.checked;
        const isTiktokBlocked = tiktokToggle.checked;
        const isSessionActive = sessionToggle.checked;

        chrome.storage.sync.set({
            instagramBlocked: isInstagramBlocked,
            tiktokBlocked: isTiktokBlocked,
            sessionActive: isSessionActive
        }, () => {
            console.log('Session toggled. Active:', isSessionActive);
        });
    });

    // Save settings when platform toggles change
    function savePlatformSettings() {
        const isInstagramBlocked = instagramToggle.checked;
        const isTiktokBlocked = tiktokToggle.checked;
        const isSessionActive = sessionToggle.checked;
        chrome.storage.sync.set({
            instagramBlocked: isInstagramBlocked,
            tiktokBlocked: isTiktokBlocked,
            sessionActive: isSessionActive
        }, () => {
            console.log('Platform settings saved');
        });
    }

    instagramToggle.addEventListener('change', savePlatformSettings);
    tiktokToggle.addEventListener('change', savePlatformSettings);
});