const button = document.getElementById('d6-button');
const icon = button.querySelector('.dice');
const dragHandle = document.querySelector('.drag-handle');
let locked = false;
let dragging;

function setDisplayMode(mode) {
  const dataMinerEnabled = mode === 'dataminer';
  icon.src = dataMinerEnabled ? 'resourcse/dataminer.png' : 'resourcse/dice.png';
  icon.alt = dataMinerEnabled ? '数据破解' : 'D6';
  const actionLabel = dataMinerEnabled ? '使用数据破解' : '使用 D6';
  button.title = `${actionLabel}随机化桌面应用图标`;
  button.setAttribute('aria-label', `${actionLabel}随机化桌面应用图标`);
}

window.d6.getDisplayMode().then(setDisplayMode).catch(console.error);
window.d6.onDisplayModeChanged(setDisplayMode);

button.addEventListener('click', async () => {
  if (locked) return;
  locked = true;
  try {
    await window.d6.randomizeDesktop();
  } catch (error) {
    console.error(error);
  } finally {
    locked = false;
  }
});

dragHandle.addEventListener('mousedown', async event => {
  if (event.button !== 0) return;
  const bounds = await window.d6.getWindowBounds();
  dragging = { startX: event.screenX, startY: event.screenY, windowX: bounds.x, windowY: bounds.y };
  event.preventDefault();
});

window.addEventListener('mousemove', event => {
  if (!dragging) return;
  window.d6.moveWindow(
    dragging.windowX + event.screenX - dragging.startX,
    dragging.windowY + event.screenY - dragging.startY
  );
});

window.addEventListener('mouseup', () => { dragging = undefined; });

window.addEventListener('contextmenu', event => {
  event.preventDefault();
  window.d6.showMenu();
});
