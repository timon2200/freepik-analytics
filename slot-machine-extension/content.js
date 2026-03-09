console.log("🎰 Slot Extension: Loaded (Capture Mode)");

const soundUrl = chrome.runtime.getURL("slot.mp3");

// We pass 'true' as the third argument. 
// This is "Capture Phase" - we catch the click BEFORE the website does.
document.addEventListener('click', function(e) {
    
    // 1. Debugging: Log exactly what was clicked
    console.log("👉 Clicked:", e.target);

    // 2. Strategy A: Check for the data-cy attribute (closest parent)
    const dataCyTarget = e.target.closest('[data-cy="generate-button"]');
    
    // 3. Strategy B: Check for the data-tour attribute (seen in your HTML)
    const dataTourTarget = e.target.closest('[data-tour="generate-button"]');

    // 4. Strategy C: Check simply for the text "Generate" inside a button
    // (This is a backup in case they change the IDs)
    const buttonTarget = e.target.closest('button');
    const isGenerateText = buttonTarget && buttonTarget.innerText.toLowerCase().includes("generate");

    if (dataCyTarget || dataTourTarget || isGenerateText) {
        console.log("🎰 JACKPOT! Generate button identified.");
        
        const audio = new Audio(soundUrl);
        audio.volume = 0.5;
        audio.play().then(() => {
            console.log("🔊 Sound playing...");
        }).catch(err => {
            console.error("🔇 Sound blocked:", err);
        });
    } else {
        console.log("❌ Not the generate button");
    }

}, true); // <--- The 'true' here is the magic fix