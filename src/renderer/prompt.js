let currentRequestId = '';

const promptText = document.getElementById('promptText');
const input = document.getElementById('input');
const submitBtn = document.getElementById('submitBtn');
const cancelBtn = document.getElementById('cancelBtn');

function sendResponse(cancelled) {
    if (!window.promptAPI) {
        return;
    }

    window.promptAPI.sendPromptResponse({
        requestId: currentRequestId,
        value: input.value,
        cancelled
    });
}

submitBtn.addEventListener('click', () => sendResponse(false));
cancelBtn.addEventListener('click', () => sendResponse(true));

input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        sendResponse(false);
    }

    if (event.key === 'Escape') {
        sendResponse(true);
    }
});

if (window.promptAPI) {
    window.promptAPI.onPromptData((payload) => {
        currentRequestId = payload.requestId;
        promptText.textContent = payload.prompt || '请输入:';
        input.value = '';
        input.focus();
    });
}
