// backend/html5.js
// Dynamic HTML5 Games registry. Add, edit, or toggle active status here.

const HTML5_GAMES = [
  {
    id: 'cut_the_rope_experiments',
    title: 'Cut The Rope',
    url: 'https://play.famobi.com/cut-the-rope-experiments',
    thumbnailUrl: 'https://i.ibb.co/vxVJmRfT/Cut-The-Rope-Experiments-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'om_nom_run',
    title: 'On Run',
    url: 'https://play.famobi.com/om-nom-run',
    thumbnailUrl: 'https://i.ibb.co/kssrK5K1/Om-Nom-Run-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'gun_spin',
    title: 'Gun Spin',
    url: 'https://play.famobi.com/gun-spin',
    thumbnailUrl: 'https://i.ibb.co/NqdnxBp/Gun-Spin-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'color_water_sort_3d',
    title: 'Color Water',
    url: 'https://play.famobi.com/color-water-sort-3d',
    thumbnailUrl: 'https://i.ibb.co/7JDKC3SC/Color-Water-Sort3d-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'word_run',
    title: 'Word Run',
    url: 'https://play.famobi.com/word-run',
    thumbnailUrl: 'https://i.ibb.co/qMqLLdc7/Word-Run-Teaser.jpg',
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
    id: '2048',
    title: '2048 Puzzle',
    url: 'https://gabrielecirulli.github.io/2048/',
    thumbnailUrl: 'https://play2048.co/ogImage.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'bubble_tower_3d',
    title: 'Bubble Tower',
    url: 'https://play.famobi.com/bubble-tower-3d',
    thumbnailUrl: 'https://i.ibb.co/XfLzGKXc/Bubble-Tower3d-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'cannon_balls_3d',
    title: 'Cannon Balls 3D',
    url: 'https://play.famobi.com/cannon-balls-3d',
    thumbnailUrl: 'https://i.ibb.co/M5P8xkbd/Cannon-Balls3d-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'tower_crash_3d',
    title: 'Tower Crash 3D',
    url: 'https://play.famobi.com/tower-crash-3d',
    thumbnailUrl: 'https://i.ibb.co/dJKp3KsL/Tower-Crash3d-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'element_blocks',
    title: 'Element Blocks',
    url: 'https://play.famobi.com/element-blocks',
    thumbnailUrl: 'https://i.ibb.co/hxKptLM4/Element-Blocks-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'zoo_boom',
    title: 'Zoo Boom',
    url: 'https://play.famobi.com/zoo-boom',
    thumbnailUrl: 'https://i.ibb.co/hxKptLM4/Element-Blocks-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'diamond_rush',
    title: 'Diamond Rush',
    url: 'https://play.famobi.com/diamond-rush',
    thumbnailUrl: 'https://i.ibb.co/HTzpgpLP/Diamond-Rush-Teaser.jpg',
    orientation: 'portrait',
    status: 'active',
  },
  {
    id: 'table_tennis_world_tour',
    title: 'Table Tennis',
    url: 'https://play.famobi.com/table-tennis-world-tour',
    thumbnailUrl: 'https://i.ibb.co/d0SMDz77/Table-Tennis-World-Tour-Teaser.jpg',
    orientation: 'portrait',
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
