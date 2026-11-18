/**
 * Recorded shapes for The Odds API v4.
 *
 * Transcribed from the published OpenAPI schema
 * (https://the-odds-api.com/api-reference/v4/schema.yml) — the field names and
 * nesting here are the documented ones, so the adapter tests assert against the
 * real contract rather than an invented one.
 */

export const THE_ODDS_API_SPORTS = [
  { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: 'English Premier League', active: true, has_outrights: false },
  { key: 'soccer_epl_winner', group: 'Soccer', title: 'EPL Winner', description: 'English Premier League Winner', active: true, has_outrights: true },
  { key: 'basketball_nba', group: 'Basketball', title: 'NBA', description: 'US Basketball', active: true, has_outrights: false },
];

/**
 * One event, two bookmakers, four markets:
 *   h2h            one market, three outcomes
 *   totals         a point (line)
 *   totals_h1      a period variant
 *   player_points  an outcome `description` carrying the player
 */
export const THE_ODDS_API_SAMPLE = [
  {
    id: 'bda33adca828c09dc3cac3a856aef176',
    sport_key: 'soccer_epl',
    sport_title: 'EPL',
    commence_time: '2026-09-27T12:00:00Z',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [
      {
        key: 'book-one',
        title: 'Book One',
        last_update: '2026-09-26T11:59:00Z',
        markets: [
          {
            key: 'h2h',
            last_update: '2026-09-26T12:00:00Z',
            outcomes: [
              { name: 'Arsenal', price: 2.1 },
              { name: 'Chelsea', price: 3.3 },
              { name: 'Draw', price: 3.4 },
            ],
          },
          {
            key: 'totals',
            last_update: '2026-09-26T12:05:00Z',
            outcomes: [
              { name: 'Over', price: 1.95, point: 2.5 },
              { name: 'Under', price: 1.88, point: 2.5 },
            ],
          },
          {
            key: 'totals_h1',
            last_update: '2026-09-26T12:05:00Z',
            outcomes: [
              { name: 'Over', price: 1.9, point: 1.5 },
              { name: 'Under', price: 1.9, point: 1.5 },
            ],
          },
          {
            key: 'player_points',
            last_update: '2026-09-26T12:06:00Z',
            outcomes: [
              { name: 'Over', price: 1.9, point: 25.5, description: 'Player One' },
              { name: 'Under', price: 1.9, point: 25.5, description: 'Player One' },
            ],
          },
        ],
      },
      {
        key: 'book-two',
        title: 'Book Two',
        last_update: '2026-09-26T11:58:00Z',
        markets: [
          {
            key: 'h2h',
            last_update: '2026-09-26T11:58:00Z',
            outcomes: [
              { name: 'Arsenal', price: 2.05 },
              { name: 'Chelsea', price: 3.4 },
              { name: 'Draw', price: 3.45 },
            ],
          },
        ],
      },
    ],
  },
];

/** A spread market: each side carries its own, opposite, point. */
export const THE_ODDS_API_SPREAD_SAMPLE = [
  {
    id: 'spread-event',
    sport_key: 'basketball_nba',
    sport_title: 'NBA',
    commence_time: '2026-09-26T12:00:00Z',
    home_team: 'Lakers',
    away_team: 'Celtics',
    bookmakers: [
      {
        key: 'book-one',
        title: 'Book One',
        last_update: '2026-09-26T11:00:00Z',
        markets: [
          {
            key: 'spreads',
            last_update: '2026-09-26T11:00:00Z',
            outcomes: [
              { name: 'Lakers', price: 1.91, point: -4.5 },
              { name: 'Celtics', price: 1.91, point: 4.5 },
              { name: 'Lakers', price: 2.4, point: -8.5 },
              { name: 'Celtics', price: 1.55, point: 8.5 },
            ],
          },
        ],
      },
    ],
  },
];
