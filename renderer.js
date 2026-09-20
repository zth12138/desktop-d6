const button = document.getElementById('d6-button');
const icon = button.querySelector('.dice');
const dragHandle = document.querySelector('.drag-handle');
const dataMinerSounds = [
  'resourcse/dataminer_01.wav',
  'resourcse/dataminer_02.wav',
  'resourcse/dataminer_03.wav'
].map(source => {
  const audio = new Audio(source);
  audio.preload = 'auto';
  return audio;
});
const d6Sound = new Audio('resourcse/the_d6_roll.wav');
d6Sound.preload = 'auto';
let locked = false;
let dragging;
let currentDisplayMode = 'd6';

function setDisplayMode(mode) {
  const dataMinerEnabled = mode === 'dataminer';
  currentDisplayMode = dataMinerEnabled ? 'dataminer' : 'd6';
  icon.src = dataMinerEnabled ? 'resourcse/dataminer.png' : 'resourcse/dice.png';
  icon.alt = dataMinerEnabled ? '数据破解' : 'D6';
  const actionLabel = dataMinerEnabled ? '使用数据破解' : '使用 D6';
  button.title = `${actionLabel}随机化桌面应用图标`;
  button.setAttribute('aria-label', `${actionLabel}随机化桌面应用图标`);
}

function playUseSound() {
  const audio = currentDisplayMode === 'dataminer'
    ? dataMinerSounds[Math.floor(Math.random() * dataMinerSounds.length)]
    : d6Sound;
  audio.currentTime = 0;
  audio.play().catch(error => console.error('道具音效播放失败：', error));
}

window.d6.getDisplayMode().then(setDisplayMode).catch(console.error);
window.d6.onDisplayModeChanged(setDisplayMode);

button.addEventListener('click', async () => {
  if (locked) return;
  locked = true;
  playUseSound();
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
  if ((event.buttons & 1) === 0) {
    dragging = undefined;
    return;
  }
  window.d6.moveWindow(
    dragging.windowX + event.screenX - dragging.startX,
    dragging.windowY + event.screenY - dragging.startY
  );
});

window.addEventListener('mouseup', () => { dragging = undefined; });
window.addEventListener('blur', () => { dragging = undefined; });

window.addEventListener('contextmenu', event => {
  event.preventDefault();
  window.d6.showMenu();
});
