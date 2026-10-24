import {Howl} from 'howler';
import audioSpriteSheet from '../../../audio.json';

// PetrifEye: audio.json names its files relative to the page, and the page
// (games/duck-hunt.html) is not in the folder the audio lives in.
const base = (window.DuckHuntConfig && window.DuckHuntConfig.assetBase) || '';
const sound = new Howl(Object.assign({}, audioSpriteSheet, {
  src: audioSpriteSheet.src.map((file) => base + file)
}));

export default sound;
