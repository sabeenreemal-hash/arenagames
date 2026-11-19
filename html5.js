// backend/html5.js
// Dynamic HTML5 Games registry. Add, edit, or toggle active status here.

const HTML5_GAMES = [
  {
    id: 'hextris',
    title: 'Hextris',
    url: 'https://hextris.github.io/hextris/',
    thumbnailUrl: 'https://hextris.github.io/hextris/images/facebook-opengraph.png',
    orientation: 'portrait', // 'portrait' | 'landscape'
    status: 'active',        // 'active' | 'inactive'
  },
  {
    id: '2048',
    title: '2048 Puzzle',
    url: 'https://gabrielecirulli.github.io/2048/',
    thumbnailUrl: 'https://play2048.co/ogImage.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'tower_building',
    title: 'Tower Builder',
    url: 'https://iamkun.github.io/tower_game/',
    thumbnailUrl: 'https://user-images.githubusercontent.com/17680888/47480922-93a20c00-d864-11e8-8f7c-6d1d60184730.gif',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'clumsy_bird',
    title: 'Clumsy Bird',
    url: 'https://ellisonleao.github.io/clumsy-bird/',
    thumbnailUrl: 'https://ellisonleao.github.io/clumsy-bird/data/img/bg.png',
    orientation: 'landscape',
    status: 'active',
  },
];

function getActiveGames() {
  return HTML5_GAMES.filter((g) => g.status === 'active');
}

function getActiveGameById(gameId) {
  return HTML5_GAMES.find((g) => g.id === gameId && g.status === 'active') || null;
}

module.exports = {
  HTML5_GAMES,
  getActiveGames,
  getActiveGameById,
};
