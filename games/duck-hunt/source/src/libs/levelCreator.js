const urlQueryString = new URLSearchParams(window.location.search);

function parseQueryParamAsInt(param) {
  return parseInt(urlQueryString.get(param), 10);
}

module.exports.parseLevelQueryString = function() {
  return {
    id: -1,
    title: urlQueryString.get('title') || 'Generated Level',
    waves: parseQueryParamAsInt('waves') || 1,
    ducks: parseQueryParamAsInt('ducks') || 1,
    pointsPerDuck: parseQueryParamAsInt('points') || 100,
    speed: parseQueryParamAsInt('speed') || 8,
    bullets: parseQueryParamAsInt('bullets') || 100,
    radius: parseQueryParamAsInt('radius') || 60,
    time: parseQueryParamAsInt('time') || 30
  };
};

// PetrifEye: only a query that actually describes a level — the page's own
// flags (?sim) used to turn every game into a one-wave "Generated Level".
const LEVEL_PARAMS = ['title', 'waves', 'ducks', 'points', 'speed', 'bullets', 'radius', 'time'];

module.exports.urlContainsLevelData = function() {
  return LEVEL_PARAMS.some((param) => urlQueryString.has(param));
};