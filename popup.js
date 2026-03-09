/* ═══════════════════════════════════════════════════
   FREEPIK ANALYTICS — Popup Script
   Shows quick stats from chrome.storage.local
   ═══════════════════════════════════════════════════ */

const STORAGE_KEY = 'freepikAnalyticsData';

async function init() {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const data = result[STORAGE_KEY];

    if (!data) {
        document.getElementById('stats').style.display = 'none';
        document.getElementById('no-data').style.display = 'block';
        return;
    }

    // Populate stats
    document.getElementById('pop-total').textContent = (data.total || 0).toLocaleString();
    document.getElementById('pop-images').textContent = (data.by_type?.image || 0).toLocaleString();
    document.getElementById('pop-videos').textContent = (data.by_type?.video || 0).toLocaleString();
    document.getElementById('pop-models').textContent = Object.keys(data.by_model || {}).length;
    document.getElementById('pop-projects').textContent = Object.keys(data.by_project || {}).length;

    // Last updated
    if (data.scraped_at) {
        const d = new Date(data.scraped_at);
        document.getElementById('pop-updated').textContent =
            `Updated ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
}

// Open Freepik in current tab when clicking the button
document.getElementById('pop-open').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url?.includes('freepik.com')) {
        // Already on Freepik, just close popup
        window.close();
    } else {
        // Navigate to Freepik
        await chrome.tabs.create({ url: 'https://www.freepik.com/pikaso/projects/history' });
        window.close();
    }
});

init();
