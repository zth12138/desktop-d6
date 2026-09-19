const button = document.getElementById('d6-button');
const dragHandle = document.querySelector('.drag-handle');
let locked = false;
let dragging;

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
