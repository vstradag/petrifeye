import Game from './src/modules/Game';

// PetrifEye: the page decides when the game starts and how it is aimed, so the
// game is created here but only begins when the page calls begin() — after the
// boot card, the webcam calibration and the trackers are settled. Everything
// the page passes in is on window.DuckHuntConfig (see games/duck-hunt.html).
document.addEventListener('DOMContentLoaded', function() {
  const config = window.DuckHuntConfig || {};

  const game = new Game(Object.assign({
    spritesheet: 'sprites.json'
  }, config));

  window.DuckHuntGame = game;
  game.load().then(() => {
    window.dispatchEvent(new CustomEvent('duckhunt-ready', {detail: {game}}));
  });

}, false);
