// backend/html5.js
// Dynamic HTML5 Games registry. Add, edit, or toggle active status here.

const HTML5_GAMES = [
  {
    id: 'om_nom_run',
    title: 'On Run', // Change to 'Om Nom Run' if preferred
    url: 'https://play.famobi.com/om-nom-run',
    thumbnailUrl: 'https://i.ibb.co/kssrK5K1/Om-Nom-Run-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'moto_x3m_pool_party',
    title: 'Moto X3M',
    url: 'https://play.famobi.com/moto-x3m-pool-party',
    thumbnailUrl: 'https://i.ibb.co/ZRwCQccG/Moto-X3m-Pool-Party-Teaser.jpg',
    orientation: 'landscape',
    status: 'active',
  },
  {
    id: 'hextris',
    title: 'Hextris',
    url: 'https://hextris.github.io/hextris/',
    thumbnailUrl: 'https://hextris.github.io/hextris/images/facebook-opengraph.png',
    orientation: 'portrait',
    status: 'active',
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
