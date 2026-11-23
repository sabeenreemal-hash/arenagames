// backend/routes/arenaPot.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// Helper: Auto-sync lottery status based on current UTC time & seat caps
function syncLotteryStatuses(callback) {
  const nowIso = new Date().toISOString();
  db.serialize(() => {
    // 1. Mark DRAFT -> ACTIVE or UPCOMING if start time reached
    db.run(
      `UPDATE arena_pot_lotteries 
       SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP 
       WHERE status = 'UPCOMING' AND start_time <= ? AND end_time > ? AND sold_seats < total_seats`,
      [nowIso, nowIso]
    );

    // 2. Mark ACTIVE -> CLOSED if end_time passed or seats filled
    db.run(
      `UPDATE arena_pot_lotteries 
       SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP 
       WHERE status = 'ACTIVE' AND (end_time <= ? OR sold_seats >= total_seats)`,
      [nowIso],
      () => {
        if (typeof callback === 'function') callback();
      }
    );
  });
}

// ==========================================
// USER ENDPOINTS
// ==========================================

// 1. Get Arena Pot Home (Featured, Active, Upcoming, Recent Winners)
router.get('/home', authenticateToken, (req, res) => {
  syncLotteryStatuses(() => {
    const query = `
      SELECT id, title, prize_title, prize_image, description, 
             total_seats, sold_seats, (total_seats - sold_seats) AS remaining_seats,
             ticket_price, user_ticket_limit, start_time, end_time, 
             winner_count, status, is_featured
      FROM arena_pot_lotteries 
      WHERE status IN ('ACTIVE', 'UPCOMING')
      ORDER BY is_featured DESC, end_time ASC
    `;

    db.all(query, [], (err, lotteries) => {
      if (err) return res.status(500).json({ error: 'Failed to load lotteries' });

      // Fetch Recent Winners
      const winnersQuery = `
        SELECT w.id, w.winner_position, w.prize_title, w.prize_amount, w.prize_type, w.published_at,
               t.ticket_number, u.username, l.title as lottery_title
        FROM arena_pot_winners w
        JOIN users u ON w.user_id = u.id
        JOIN arena_pot_tickets t ON w.ticket_id = t.id
        JOIN arena_pot_lotteries l ON w.lottery_id = l.id
        ORDER BY w.published_at DESC LIMIT 10
      `;

      db.all(winnersQuery, [], (wErr, recentWinners) => {
        const featured = (lotteries || []).find((l) => l.is_featured === 1 && l.status === 'ACTIVE') || null;
        const active = (lotteries || []).filter((l) => l.status === 'ACTIVE');
        const upcoming = (lotteries || []).filter((l) => l.status === 'UPCOMING');

        res.json({
          success: true,
          featured,
          active,
          upcoming,
          recent_winners: recentWinners || [],
        });
      });
    });
  });
});

// 2. Get Single Lottery Details (Rules, Prizes, User's Purchased Tickets)
router.get('/lottery/:id', authenticateToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const userId = req.user.id;

  syncLotteryStatuses(() => {
    db.get(
      `SELECT *, (total_seats - sold_seats) AS remaining_seats 
       FROM arena_pot_lotteries WHERE id = ?`,
      [lotteryId],
      (err, lottery) => {
        if (err || !lottery) return res.status(404).json({ error: 'Lottery not found' });

        // Get Prizes
        db.all(
          `SELECT winner_position, prize_type, prize_amount, prize_title 
           FROM arena_pot_prizes WHERE lottery_id = ? ORDER BY winner_position ASC`,
          [lotteryId],
          (pErr, prizes) => {
            // Get user's own tickets in this lottery
            db.all(
              `SELECT id, ticket_number, purchased_at 
               FROM arena_pot_tickets WHERE lottery_id = ? AND user_id = ? ORDER BY ticket_number ASC`,
              [lotteryId, userId],
              (tErr, myTickets) => {
                // If closed/published, fetch winners
                db.all(
                  `SELECT w.winner_position, w.prize_title, w.prize_amount, w.prize_type,
                          t.ticket_number, u.username
                   FROM arena_pot_winners w
                   JOIN users u ON w.user_id = u.id
                   JOIN arena_pot_tickets t ON w.ticket_id = t.id
                   WHERE w.lottery_id = ?
                   ORDER BY w.winner_position ASC`,
                  [lotteryId],
                  (wErr, winners) => {
                    res.json({
                      success: true,
                      lottery,
                      prizes: prizes || [],
                      my_tickets: myTickets || [],
                      my_ticket_count: (myTickets || []).length,
                      winners: winners || []
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// 3. Purchase Lottery Tickets
router.post('/lottery/:id/buy', authenticateToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const userId = req.user.id;
  const count = parseInt(req.body.count, 10);

  if (isNaN(count) || count <= 0) {
    return res.status(400).json({ error: 'Please specify a valid ticket quantity.' });
  }

  db.serialize(() => {
    db.run('BEGIN IMMEDIATE TRANSACTION');

    // 1. Fetch current lottery state
    db.get(
      `SELECT * FROM arena_pot_lotteries WHERE id = ?`,
      [lotteryId],
      (lErr, lottery) => {
        if (lErr || !lottery) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Lottery not found' });
        }

        const nowIso = new Date().toISOString();
        if (lottery.status !== 'ACTIVE' || lottery.end_time <= nowIso) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'This lottery is not active for ticket purchases.' });
        }

        const remainingSeats = lottery.total_seats - lottery.sold_seats;
        if (count > remainingSeats) {
          db.run('ROLLBACK');
          return res.status(400).json({
            error: `Only ${remainingSeats} seat(s) remaining. Cannot purchase ${count} ticket(s).`,
          });
        }

        // 2. Validate User Ticket Limit
        db.get(
          `SELECT COUNT(*) as existing_count FROM arena_pot_tickets WHERE lottery_id = ? AND user_id = ?`,
          [lotteryId, userId],
          (cErr, userCountRow) => {
            const existingCount = userCountRow ? userCountRow.existing_count : 0;
            if (lottery.user_ticket_limit > 0 && existingCount + count > lottery.user_ticket_limit) {
              db.run('ROLLBACK');
              return res.status(400).json({
                error: `User ticket limit is ${lottery.user_ticket_limit}. You already own ${existingCount} ticket(s).`,
              });
            }

            const totalCost = lottery.ticket_price * count;

            // 3. Check user balance
            db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (uErr, user) => {
              if (uErr || !user) {
                db.run('ROLLBACK');
                return res.status(404).json({ error: 'User profile not found' });
              }

              if (user.balance < totalCost) {
                db.run('ROLLBACK');
                return res.status(400).json({
                  error: `Insufficient coins. You have ${user.balance} coins, but ${totalCost} coins are required.`,
                });
              }

              // 4. Generate sequential ticket numbers starting from sold_seats + 1
              const startingTicketNumber = lottery.sold_seats + 1;
              const assignedTickets = [];
              const ticketValuesSql = [];
              const ticketParams = [];

              for (let i = 0; i < count; i++) {
                const ticketNum = startingTicketNumber + i;
                assignedTickets.push(ticketNum);
                ticketValuesSql.push('(?, ?, ?, ?)');
                ticketParams.push(lotteryId, userId, ticketNum, lottery.ticket_price);
              }

              // 5. Insert Tickets
              const insertTicketsQuery = `
                INSERT INTO arena_pot_tickets (lottery_id, user_id, ticket_number, coin_price)
                VALUES ${ticketValuesSql.join(', ')}
              `;

              db.run(insertTicketsQuery, ticketParams, function (tErr) {
                if (tErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to assign tickets: ' + tErr.message });
                }

                const newSoldSeats = lottery.sold_seats + count;
                const newStatus = newSoldSeats >= lottery.total_seats ? 'CLOSED' : 'ACTIVE';

                // 6. Update Lottery Seat Counter
                db.run(
                  `UPDATE arena_pot_lotteries 
                   SET sold_seats = ?, status = ?, updated_at = CURRENT_TIMESTAMP 
                   WHERE id = ?`,
                  [newSoldSeats, newStatus, lotteryId],
                  (updateLotteryErr) => {
                    if (updateLotteryErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: 'Failed to update lottery seats' });
                    }

                    // 7. Deduct User Wallet Coins
                    db.run(
                      `UPDATE users SET balance = balance - ? WHERE id = ?`,
                      [totalCost, userId],
                      (balErr) => {
                        if (balErr) {
                          db.run('ROLLBACK');
                          return res.status(500).json({ error: 'Failed to deduct wallet coins' });
                        }

                        // 8. Log into Central Transactions Table
                        const refId = `ARENA_POT_${lotteryId}_${Date.now()}`;
                        db.run(
                          `INSERT INTO transactions (user_id, type, amount, reference_id) 
                           VALUES (?, 'POT_TICKET_PURCHASE', ?, ?)`,
                          [userId, -totalCost, refId],
                          (txErr) => {
                            if (txErr) {
                              db.run('ROLLBACK');
                              return res.status(500).json({ error: 'Failed to record transaction' });
                            }

                            db.run('COMMIT', (commitErr) => {
                              if (commitErr) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ error: 'Transaction commit failed' });
                              }

                              res.json({
                                success: true,
                                message: `Successfully purchased ${count} ticket(s)!`,
                                tickets: assignedTickets,
                                coins_spent: totalCost,
                                new_balance: user.balance - totalCost,
                                remaining_seats: lottery.total_seats - newSoldSeats,
                              });
                            });
                          }
                        );
                      }
                    );
                  }
                );
              });
            });
          }
        );
      }
    );
  });
});

// 4. View Participants in a Lottery
router.get('/lottery/:id/participants', authenticateToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const query = `
    SELECT u.id as user_id, u.username, 
           COUNT(t.id) as ticket_count, 
           SUM(t.coin_price) as total_spent,
           MIN(t.purchased_at) as joined_at
    FROM arena_pot_tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.lottery_id = ?
    GROUP BY t.user_id
    ORDER BY ticket_count DESC, joined_at ASC
  `;

  db.all(query, [lotteryId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load participants' });
    res.json({ success: true, participants: rows || [] });
  });
});

// 5. My Tickets (All purchased tickets across all lotteries)
router.get('/my-tickets', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const query = `
    SELECT t.id, t.lottery_id, t.ticket_number, t.coin_price, t.purchased_at,
           l.title as lottery_title, l.prize_title, l.status as lottery_status,
           l.end_time,
           CASE WHEN w.id IS NOT NULL THEN 1 ELSE 0 END AS is_winner,
           w.winner_position, w.prize_title as won_prize
    FROM arena_pot_tickets t
    JOIN arena_pot_lotteries l ON t.lottery_id = l.id
    LEFT JOIN arena_pot_winners w ON (t.id = w.ticket_id)
    WHERE t.user_id = ?
    ORDER BY t.purchased_at DESC
  `;

  db.all(query, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load user tickets' });
    res.json({ success: true, tickets: rows || [] });
  });
});

// 6. All Winners History
router.get('/winners/all', authenticateToken, (req, res) => {
  const query = `
    SELECT w.id, w.winner_position, w.prize_title, w.prize_amount, w.prize_type, w.published_at,
           t.ticket_number, u.username, l.title as lottery_title, l.id as lottery_id
    FROM arena_pot_winners w
    JOIN users u ON w.user_id = u.id
    JOIN arena_pot_tickets t ON w.ticket_id = t.id
    JOIN arena_pot_lotteries l ON w.lottery_id = l.id
    ORDER BY w.published_at DESC LIMIT 200
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load winners history' });
    res.json({ success: true, winners: rows || [] });
  });
});

// ==========================================
// ADMIN ENDPOINTS (Requires Admin Authentication)
// ==========================================

// Middleware for Admin operations
function requireAdmin(req, res, next) {
  // Can use your admin JWT auth or admin role check
  if (req.user && req.user.isAdmin) {
    return next();
  }
  return res.status(403).json({ error: 'Unauthorized: Admin privileges required.' });
}

// Admin: Create New Lottery with Prizes
router.post('/admin/create', authenticateToken, requireAdmin, (req, res) => {
  const {
    title,
    prize_title,
    prize_image,
    description,
    total_seats,
    ticket_price,
    user_ticket_limit,
    start_time,
    end_time,
    winner_count,
    is_featured,
    prizes, // Array of { winner_position, prize_type, prize_amount, prize_title }
  } = req.body;

  if (!title || !prize_title || !total_seats || !start_time || !end_time) {
    return res.status(400).json({ error: 'Missing required lottery configuration fields.' });
  }

  const now = new Date();
  const startDate = new Date(start_time);
  const status = startDate <= now ? 'ACTIVE' : 'UPCOMING';

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.run(
      `INSERT INTO arena_pot_lotteries 
       (title, prize_title, prize_image, description, total_seats, ticket_price, 
        user_ticket_limit, start_time, end_time, winner_count, status, is_featured, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        prize_title,
        prize_image || '',
        description || '',
        parseInt(total_seats, 10),
        parseInt(ticket_price || 50, 10),
        parseInt(user_ticket_limit || 0, 10),
        start_time,
        end_time,
        parseInt(winner_count || 1, 10),
        status,
        is_featured ? 1 : 0,
        req.user.id,
      ],
      function (err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to create lottery: ' + err.message });
        }

        const lotteryId = this.lastID;

        // Insert Prizes
        if (Array.isArray(prizes) && prizes.length > 0) {
          const prizeSql = [];
          const prizeParams = [];
          for (const p of prizes) {
            prizeSql.push('(?, ?, ?, ?, ?)');
            prizeParams.push(
              lotteryId,
              p.winner_position,
              p.prize_type || 'COINS',
              p.prize_amount || 0,
              p.prize_title || `Rank ${p.winner_position} Prize`
            );
          }
          db.run(
            `INSERT INTO arena_pot_prizes (lottery_id, winner_position, prize_type, prize_amount, prize_title)
             VALUES ${prizeSql.join(', ')}`,
            prizeParams,
            (pErr) => {
              if (pErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to insert prizes' });
              }

              db.run('COMMIT', () => {
                res.json({ success: true, message: 'Lottery created successfully!', lottery_id: lotteryId });
              });
            }
          );
        } else {
          db.run('COMMIT', () => {
            res.json({ success: true, message: 'Lottery created successfully!', lottery_id: lotteryId });
          });
        }
      }
    );
  });
});

// Admin: Publish / Settle Winners
router.post('/admin/lottery/:id/draw', authenticateToken, requireAdmin, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const { winners } = req.body; 
  // winners: [ { position: 1, ticketNumber: 104 }, ... ] or empty for auto-random pick

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get('SELECT * FROM arena_pot_lotteries WHERE id = ?', [lotteryId], (err, lottery) => {
      if (err || !lottery) {
        db.run('ROLLBACK');
        return res.status(404).json({ error: 'Lottery not found' });
      }

      if (lottery.status === 'RESULTS_PUBLISHED' || lottery.status === 'COMPLETED') {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'Results have already been published for this lottery.' });
      }

      // Fetch all configured prizes
      db.all(
        'SELECT * FROM arena_pot_prizes WHERE lottery_id = ? ORDER BY winner_position ASC',
        [lotteryId],
        (pErr, prizes) => {
          if (!prizes || prizes.length === 0) {
            db.run('ROLLBACK');
            return res.status(400).json({ error: 'No prizes configured for this lottery.' });
          }

          // Fetch all valid sold tickets
          db.all(
            'SELECT id, ticket_number, user_id FROM arena_pot_tickets WHERE lottery_id = ?',
            [lotteryId],
            (tErr, soldTickets) => {
              if (!soldTickets || soldTickets.length === 0) {
                db.run('ROLLBACK');
                return res.status(400).json({ error: 'No tickets were purchased for this lottery.' });
              }

              const selectedWinners = [];
              const usedTicketIds = new Set();

              // Manual or Random Selection
              for (const prize of prizes) {
                let chosenTicket = null;

                if (Array.isArray(winners)) {
                  const assigned = winners.find((w) => w.position === prize.winner_position);
                  if (assigned) {
                    chosenTicket = soldTickets.find(
                      (t) => t.ticket_number === assigned.ticketNumber && !usedTicketIds.has(t.id)
                    );
                  }
                }

                // If not manually assigned or not found, pick random remaining ticket
                if (!chosenTicket) {
                  const available = soldTickets.filter((t) => !usedTicketIds.has(t.id));
                  if (available.length > 0) {
                    const rnd = Math.floor(Math.random() * available.length);
                    chosenTicket = available[rnd];
                  }
                }

                if (chosenTicket) {
                  usedTicketIds.add(chosenTicket.id);
                  selectedWinners.push({
                    lottery_id: lotteryId,
                    ticket_id: chosenTicket.id,
                    user_id: chosenTicket.user_id,
                    winner_position: prize.winner_position,
                    prize_id: prize.id,
                    prize_title: prize.prize_title,
                    prize_type: prize.prize_type,
                    prize_amount: prize.prize_amount,
                  });
                }
              }

              // Insert Winner Records & credit coins if COINS
              for (const win of selectedWinners) {
                db.run(
                  `INSERT INTO arena_pot_winners 
                   (lottery_id, ticket_id, user_id, winner_position, prize_id, prize_title, prize_type, prize_amount)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    win.lottery_id,
                    win.ticket_id,
                    win.user_id,
                    win.winner_position,
                    win.prize_id,
                    win.prize_title,
                    win.prize_type,
                    win.prize_amount,
                  ]
                );

                if (win.prize_type === 'COINS' && win.prize_amount > 0) {
                  db.run(
                    `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
                    [win.prize_amount, win.prize_amount, win.user_id]
                  );

                  const refId = `POT_WIN_${lotteryId}_POS_${win.winner_position}`;
                  db.run(
                    `INSERT INTO transactions (user_id, type, amount, reference_id) 
                     VALUES (?, 'ARENA_POT_WIN', ?, ?)`,
                    [win.user_id, win.prize_amount, refId]
                  );
                }
              }

              // Update lottery status
              db.run(
                `UPDATE arena_pot_lotteries 
                 SET status = 'RESULTS_PUBLISHED', updated_at = CURRENT_TIMESTAMP 
                 WHERE id = ?`,
                [lotteryId],
                () => {
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: 'Commit failed' });
                    }
                    res.json({
                      success: true,
                      message: `Successfully drawn and published ${selectedWinners.length} winner(s)!`,
                      winners: selectedWinners,
                    });
                  });
                }
              );
            }
          );
        }
      );
    });
  });
});

module.exports = router;
