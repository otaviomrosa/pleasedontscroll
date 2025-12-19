// popup.js

document.addEventListener('DOMContentLoaded', () => {
    const instagramToggle = document.getElementById('instagram-toggle');
    const tiktokToggle = document.getElementById('tiktok-toggle');

    // 1. LOAD SAVED SETTINGS
    // We only care about specific platforms now, no master session
    chrome.storage.sync.get(['instagramBlocked', 'tiktokBlocked'], (result) => {
        instagramToggle.checked = result.instagramBlocked || false;
        tiktokToggle.checked = result.tiktokBlocked || false;
    });

    // 2. SAVE SETTINGS
    function savePlatformSettings() {
        const isInstagramBlocked = instagramToggle.checked;
        const isTiktokBlocked = tiktokToggle.checked;

        chrome.storage.sync.set({
            instagramBlocked: isInstagramBlocked,
            tiktokBlocked: isTiktokBlocked
        }, () => {
            console.log('Settings saved:', { isInstagramBlocked, isTiktokBlocked });
        });
    }

    // Add listeners to individual toggles
    instagramToggle.addEventListener('change', savePlatformSettings);
    tiktokToggle.addEventListener('change', savePlatformSettings);
});