import {Assets, autoDetectRenderer} from 'pixi.js';
import {remove as _remove} from 'lodash/array';
import levels from '../data/levels.json';
import Stage from './Stage';
import sound from './Sound';
import levelCreator from '../libs/levelCreator.js';
import utils from '../libs/utils';

const BLUE_SKY_COLOR = 0x64b0ff;
const PINK_SKY_COLOR = 0xfbb4d4;
const SUCCESS_RATIO = 0.6;
const BOTTOM_LINK_STYLE = {
  fontFamily: 'Arial',
  fontSize: '15px',
  align: 'left',
  fill: 'white'
};

class Game {
  /**
   * Game Constructor
   * @param opts
   * @param {String} opts.spritesheet Path to the spritesheet file that PIXI's loader should load
   * @returns {Game}
   */
  constructor(opts) {
    this.spritesheet = opts.spritesheet;
    // PetrifEye options. Upstream behaviour is the default for each, so the
    // game still plays as the original when none are passed.
    //   clickToShoot  false: a click no longer fires; the page calls shootDuck()
    //   links         false: no pause/mute/fullscreen/creator links (they sit
    //                 under the bottom-right AprilTag); the page binds keys
    //   keys          false: the page owns the keyboard
    //   autoStart     false: wait for begin()
    //   pace          share of the original flight speed, 0-1 (1 = upstream)
    //                 — gaze has to follow a duck, and two people find it
    //   parent        element to put the canvas in
    this.clickToShoot = opts.clickToShoot !== false;
    this.showLinks = opts.links !== false;
    this.bindKeys = opts.keys !== false;
    this.autoStart = opts.autoStart !== false;
    this.pace = opts.pace > 0 ? opts.pace : 1;
    this.parent = opts.parent || null;
    this.started = false;
    this.levelIndex = 0;
    this.maxScore = 0;
    this.timePaused = 0;
    this.muted = false;
    this.paused = false;
    this.activeSounds = [];

    this.waveEnding = false;
    this.quackingSoundId = null;
    this.levels = levels.normal;
    return this;
  }

  get ducksMissed() {
    return this.ducksMissedVal ? this.ducksMissedVal : 0;
  }

  set ducksMissed(val) {
    this.ducksMissedVal = val;

    if (this.stage && this.stage.hud) {

      if (!Object.prototype.hasOwnProperty.call(this.stage.hud,'ducksMissed')) {
        this.stage.hud.createTextureBasedCounter('ducksMissed', {
          texture: 'hud/score-live/0.png',
          spritesheet: this.spritesheet,
          location: Stage.missedDuckStatusBoxLocation(),
          rowMax: 20,
          max: 20
        });
      }

      this.stage.hud.ducksMissed = val;
    }
  }

  get ducksShot() {
    return this.ducksShotVal ? this.ducksShotVal : 0;
  }

  set ducksShot(val) {
    this.ducksShotVal = val;

    if (this.stage && this.stage.hud) {

      if (!Object.prototype.hasOwnProperty.call(this.stage.hud,'ducksShot')) {
        this.stage.hud.createTextureBasedCounter('ducksShot', {
          texture: 'hud/score-dead/0.png',
          spritesheet: this.spritesheet,
          location: Stage.deadDuckStatusBoxLocation(),
          rowMax:20,
          max: 20
        });
      }

      this.stage.hud.ducksShot = val;
    }
  }
  /**
   * bullets - getter
   * @returns {Number}
   */
  get bullets() {
    return this.bulletVal ? this.bulletVal : 0;
  }

  /**
   * bullets - setter
   * Setter for the bullets property of the game. Also in charge of updating the HUD. In the event
   * the HUD doesn't know about displaying bullets, the property and a corresponding texture container
   * will be created in HUD.
   * @param {Number} val Number of bullets
   */
  set bullets(val) {
    this.bulletVal = val;

    if (this.stage && this.stage.hud) {

      if (!Object.prototype.hasOwnProperty.call(this.stage.hud,'bullets')) {
        this.stage.hud.createTextureBasedCounter('bullets', {
          texture: 'hud/bullet/0.png',
          spritesheet: this.spritesheet,
          location: Stage.bulletStatusBoxLocation(),
          max: 80,
          rowMax: 20
        });
      }

      this.stage.hud.bullets = val;
    }

  }

  /**
   * score - getter
   * @returns {Number}
   */
  get score() {
    return this.scoreVal ? this.scoreVal : 0;
  }

  /**
   * score - setter
   * Setter for the score property of the game. Also in charge of updating the HUD. In the event
   * the HUD doesn't know about displaying the score, the property and a corresponding text box
   * will be created in HUD.
   * @param {Number} val Score value to set
   */
  set score(val) {
    this.scoreVal = val;

    if (this.stage && this.stage.hud) {

      if (!Object.prototype.hasOwnProperty.call(this.stage.hud,'score')) {
        this.stage.hud.createTextBox('score', {
          style: {
            fontFamily: 'Arial',
            fontSize: '18px',
            align: 'left',
            fill: 'white'
          },
          location: Stage.scoreBoxLocation(),
          anchor: {
            x: 1,
            y: 0
          }
        });
      }

      this.stage.hud.score = val;
    }

  }

  /**
   * wave - get
   * @returns {Number}
   */
  get wave() {
    return this.waveVal ? this.waveVal : 0;
  }

  /**
   * wave - set
   * Setter for the wave property of the game. Also in charge of updating the HUD. In the event
   * the HUD doesn't know about displaying the wave, the property and a corresponding text box
   * will be created in the HUD.
   * @param {Number} val
   */
  set wave(val) {
    this.waveVal = val;

    if (this.stage && this.stage.hud) {

      if (!Object.prototype.hasOwnProperty.call(this.stage.hud,'waveStatus')) {
        this.stage.hud.createTextBox('waveStatus', {
          style: {
            fontFamily: 'Arial',
            fontSize: '14px',
            align: 'center',
            fill: 'white'
          },
          location: Stage.waveStatusBoxLocation(),
          anchor: {
            x: 1,
            y: 1
          }
        });
      }

      if (!isNaN(val) && val > 0) {
        this.stage.hud.waveStatus = 'wave ' + val + ' of ' + this.level.waves;
      } else {
        this.stage.hud.waveStatus = '';
      }
    }
  }

  /**
   * gameStatus - get
   * @returns {String}
   */
  get gameStatus() {
    return this.gameStatusVal ? this.gameStatusVal : '';
  }

  /**
   * gameStatus - set
   * @param {String} val
   */
  set gameStatus(val) {
    this.gameStatusVal = val;

    if (this.stage && this.stage.hud) {

      if (!Object.prototype.hasOwnProperty.call(this.stage.hud,'gameStatus')) {
        this.stage.hud.createTextBox('gameStatus', {
          style: {
            fontFamily: 'Arial',
            fontSize: '40px',
            align: 'left',
            fill: 'white'
          },
          location: Stage.gameStatusBoxLocation()
        });
      }

      this.stage.hud.gameStatus = val;
    }
  }

  async load() {
    this.renderer = await autoDetectRenderer({
      width: window.innerWidth,
      height: window.innerHeight,
      background: BLUE_SKY_COLOR
    });
    await Assets.load(this.spritesheet);
    this.onLoad();
  }

  onLoad() {
    (this.parent || document.body).appendChild(this.renderer.canvas);

    this.stage = new Stage({
      spritesheet: this.spritesheet
    });

    this.scaleToWindow();
    if (this.showLinks) {
      this.addLinkToLevelCreator();
      this.addPauseLink();
      this.addMuteLink();
      this.addFullscreenLink();
    }
    this.bindEvents();
    if (this.autoStart) {
      this.begin();
    }
    this.animate();

  }

  /**
   * begin
   * Starts the first level. Called on load unless autoStart is false.
   */
  begin() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.startLevel();
  }

  /**
   * restart
   * A new game from level 1 without reloading the page — upstream's replay
   * reloads, which here would also throw away the boot card, the webcam
   * calibration and every bridge connection.
   */
  restart() {
    if (this.stage.hud.replayButton) {
      this.stage.hud.replayButton = '';
    }
    sound.stop();
    this.activeSounds = [];
    this.stage.dog.stopAndClearTimeline();
    this.stage.dog.visible = false;
    this.stage.cleanUpDucks();
    this.stage.unlock();
    this.renderer.background.color = BLUE_SKY_COLOR;
    this.levelIndex = 0;
    this.maxScore = 0;
    this.score = 0;
    this.wave = 0;
    this.gameStatus = '';
    this.started = true;
    this.startLevel();
  }

  get over() {
    return !!this.stage.hud.replayButton;
  }

  /**
   * shootable
   * Whether a shot would count right now — the same conditions a click had.
   * @returns {Boolean}
   */
  shootable() {
    return this.started && !this.over && !this.outOfAmmo() && !this.shouldWaveEnd() && !this.paused && !this.waveEnding;
  }

  /**
   * duckTargets
   * Live ducks in SCREEN pixels, for aiming with something other than a click.
   * The stage is stretched to the window on each axis separately, so the
   * radius is the sprite's own half-size on the smaller axis.
   * @returns {{id:String, duck:Duck, x:Number, y:Number, radius:Number}[]}
   */
  duckTargets() {
    if (!this.stage) {
      return [];
    }
    const sx = this.stage.scale.x;
    const sy = this.stage.scale.y;
    return this.stage.ducks
      .filter((duck) => duck.alive && duck.visible)
      .map((duck) => ({
        id: duck.duckId,
        duck,
        x: duck.position.x * sx,
        y: duck.position.y * sy,
        radius: Math.min(duck.width * sx, duck.height * sy) / 2
      }));
  }

  /**
   * shootDuck
   * Fires one shot at exactly this duck: the gun sound, the flash, a bullet
   * and the score, as a click on it would have. Returns whether it counted.
   * @param {Duck} duck
   * @returns {Boolean}
   */
  shootDuck(duck) {
    if (!this.shootable() || !duck || !duck.alive) {
      return false;
    }
    sound.play('gunSound');
    this.bullets -= 1;
    this.updateScore(this.stage.shootDuck(duck));
    return true;
  }

  addFullscreenLink() {
    this.stage.hud.createTextBox('fullscreenLink', {
      style: BOTTOM_LINK_STYLE,
      location: Stage.fullscreenLinkBoxLocation(),
      anchor: {
        x: 1,
        y: 1
      }
    });
    this.stage.hud.fullscreenLink = 'fullscreen (f)';
  }
  addMuteLink() {
    this.stage.hud.createTextBox('muteLink', {
      style: BOTTOM_LINK_STYLE,
      location: Stage.muteLinkBoxLocation(),
      anchor: {
        x: 1,
        y: 1
      }
    });
    this.stage.hud.muteLink = 'mute (m)';
  }

  addPauseLink() {
    this.stage.hud.createTextBox('pauseLink', {
      style: BOTTOM_LINK_STYLE,
      location: Stage.pauseLinkBoxLocation(),
      anchor: {
        x: 1,
        y: 1
      }
    });
    this.stage.hud.pauseLink = 'pause (p)';
  }

  addLinkToLevelCreator() {
    this.stage.hud.createTextBox('levelCreatorLink', {
      style: BOTTOM_LINK_STYLE,
      location: Stage.levelCreatorLinkBoxLocation(),
      anchor: {
        x: 1,
        y: 1
      }
    });
    this.stage.hud.levelCreatorLink = 'level creator (c)';
  }

  bindEvents() {
    window.addEventListener('resize', this.scaleToWindow.bind(this));

    this.renderer.canvas.addEventListener('pointerdown', this.handleClick.bind(this));

    document.addEventListener('keypress', (event) => {
      if (!this.bindKeys) {
        return;
      }
      event.stopImmediatePropagation();

      if (event.key === 'p') {
        this.pause();
      }

      if (event.key === 'm') {
        this.mute();
      }

      if (event.key === 'c') {
        this.openLevelCreator();
      }

      if (event.key === 'f') {
        this.fullscreen();
      }
    });

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        this.stage.hud.fullscreenLink = 'unfullscreen (f)';
      } else {
        this.stage.hud.fullscreenLink = 'fullscreen (f)';
      }
    });

    sound.on('play', (soundId) => {
      if (this.activeSounds.indexOf(soundId) === -1) {
        this.activeSounds.push(soundId);
      }
    });
    sound.on('stop', this.removeActiveSound.bind(this));
    sound.on('end', this.removeActiveSound.bind(this));
  }

  fullscreen() {
    this.isFullscreen = !this.isFullscreen;
    utils.toggleFullscreen();
  }

  pause() {
    if (this.showLinks) {
      this.stage.hud.pauseLink = this.paused ? 'pause (p)' : 'unpause (p)';
    }
    // SetTimeout, woof. Thing is here we need to leave enough animation frames for the HUD status to be updated
    // before pausing all rendering, otherwise the text update we need above won't be shown to the user.
    setTimeout(() => {
      this.paused = !this.paused;
      if (this.paused) {
        this.pauseStartTime = Date.now();
        this.stage.pause();
        this.activeSounds.forEach((soundId) => {
          sound.pause(soundId);
        });
      } else {
        this.timePaused += (Date.now() - this.pauseStartTime) / 1000;
        this.stage.resume();
        this.activeSounds.forEach((soundId) => {
          sound.play(soundId);
        });
      }
    }, 40);
  }

  removeActiveSound(soundId) {
    _remove(this.activeSounds, function(item) {
      return item === soundId;
    });
  }

  mute() {
    if (this.showLinks) {
      this.stage.hud.muteLink = this.muted ? 'mute (m)' : 'unmute (m)';
    }
    this.muted = !this.muted;
    sound.mute(this.muted);
  }

  scaleToWindow() {
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.stage.scaleToWindow();
  }

  startLevel() {
    if (levelCreator.urlContainsLevelData()) {
      this.level = levelCreator.parseLevelQueryString();
      this.levelIndex = this.levels.length - 1;
    } else {
      this.level = this.levels[this.levelIndex];
    }

    this.maxScore += this.level.waves * this.level.ducks * this.level.pointsPerDuck;
    this.ducksShot = 0;
    this.ducksMissed = 0;
    this.wave = 0;

    this.gameStatus = this.level.title;
    this.stage.preLevelAnimation().then(() => {
      this.gameStatus = '';
      this.startWave();
    });
  }

  startWave() {
    this.quackingSoundId = sound.play('quacking');
    this.wave += 1;
    this.waveStartTime = Date.now();
    this.bullets = this.level.bullets;
    this.ducksShotThisWave = 0;
    this.waveEnding = false;

    this.stage.addDucks(this.level.ducks, this.level.speed, this.pace);
    window.dispatchEvent(new CustomEvent('duckhunt-wave', {
      detail: {level: this.level.id, wave: this.wave, ducks: this.level.ducks}
    }));
  }

  endWave() {
    this.waveEnding = true;
    this.bullets = 0;
    sound.stop(this.quackingSoundId);
    if (this.stage.ducksAlive()) {
      this.ducksMissed += this.level.ducks - this.ducksShotThisWave;
      this.renderer.background.color = PINK_SKY_COLOR;
      this.stage.flyAway().then(this.goToNextWave.bind(this));
    } else {
      this.stage.cleanUpDucks();
      this.goToNextWave();
    }
  }

  goToNextWave() {
    this.renderer.background.color = BLUE_SKY_COLOR;
    if (this.level.waves === this.wave) {
      this.endLevel();
    } else {
      this.startWave();
    }
  }

  shouldWaveEnd() {
    // evaluate pre-requisites for a wave to end
    if (this.wave === 0 || this.waveEnding || this.stage.dogActive()) {
      return false;
    }

    return this.isWaveTimeUp() || (this.outOfAmmo() && this.stage.ducksAlive()) || !this.stage.ducksActive();
  }

  isWaveTimeUp() {
    return this.level ? this.waveElapsedTime() >= this.level.time : false;
  }

  waveElapsedTime() {
    return ((Date.now() - this.waveStartTime) / 1000) - this.timePaused;
  }

  outOfAmmo() {
    return this.level && this.bullets === 0;
  }

  endLevel() {
    this.wave = 0;
    this.goToNextLevel();
  }

  goToNextLevel() {
    this.levelIndex++;
    if (!this.levelWon()) {
      this.loss();
    } else if (this.levelIndex < this.levels.length) {
      this.startLevel();
    } else {
      this.win();
    }
  }

  levelWon() {
    return this.ducksShot > SUCCESS_RATIO * this.level.ducks * this.level.waves;
  }

  win() {
    sound.play('champ');
    this.gameStatus = 'You Win!';
    this.showReplay(this.getScoreMessage());
    window.dispatchEvent(new CustomEvent('duckhunt-over', {detail: {won: true, score: this.score}}));
  }

  loss() {
    sound.play('loserSound');
    this.gameStatus = 'You Lose!';
    this.showReplay(this.getScoreMessage());
    window.dispatchEvent(new CustomEvent('duckhunt-over', {detail: {won: false, score: this.score}}));
  }

  getScoreMessage() {
    let scoreMessage;

    const percentage = (this.score / this.maxScore) * 100;

    if (percentage === 100) {
      scoreMessage = 'Flawless victory.';
    }

    if (percentage < 100) {
      scoreMessage = 'Close to perfection.';
    }

    if (percentage <= 95) {
      scoreMessage = 'Truly impressive score.';
    }

    if (percentage <= 85) {
      scoreMessage = 'Solid score.';
    }

    if (percentage <= 75) {
      scoreMessage = 'Participation award.';
    }

    if (percentage <= 63) {
      scoreMessage = 'Yikes.';
    }

    return scoreMessage;
  }

  showReplay(replayText) {
    this.stage.hud.createTextBox('replayButton', {
      location: Stage.replayButtonLocation()
    });
    this.stage.hud.replayButton = replayText + ' Play Again?';
  }

  openLevelCreator() {
    // If they didn't pause the game, pause it for them
    if (!this.paused) {
      this.pause();
    }
    window.open('/creator.html', '_blank');
  }

  handleClick(event) {
    const clickPoint = {
      x: event.clientX,
      y: event.clientY
    };

    if (this.showLinks) {
      if (this.stage.clickedPauseLink(clickPoint)) {
        this.pause();
        return;
      }

      if (this.stage.clickedMuteLink(clickPoint)) {
        this.mute();
        return;
      }

      if (this.stage.clickedFullscreenLink(clickPoint)) {
        this.fullscreen();
        return;
      }

      if (this.stage.clickedLevelCreatorLink(clickPoint)) {
        this.openLevelCreator();
        return;
      }
    }

    if (this.clickToShoot && !this.stage.hud.replayButton && !this.outOfAmmo() && !this.shouldWaveEnd() && !this.paused) {
      sound.play('gunSound');
      this.bullets -= 1;
      this.updateScore(this.stage.shotsFired(clickPoint, this.level.radius));
      return;
    }

    if (this.stage.hud.replayButton && this.stage.clickedReplay(clickPoint)) {
      if (this.clickToShoot) {
        window.location = window.location.pathname;
      } else {
        this.restart();
      }
    }
  }

  updateScore(ducksShot) {
    this.ducksShot += ducksShot;
    this.ducksShotThisWave += ducksShot;
    this.score += ducksShot * this.level.pointsPerDuck;
  }

  animate() {
    if (!this.paused) {
      this.renderer.render(this.stage);

      if (this.shouldWaveEnd()) {
        this.endWave();
      }
    }

    requestAnimationFrame(this.animate.bind(this));
  }
}

export default Game;
