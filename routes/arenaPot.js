// backend/routes/arenaPot.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authenticateToken = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'arena_games_jwt_secret_key_2025';

// ---------------------------------------------------------------------------
// Helpers & Middleware
// ---------------------------------------------------------------------------

// Auto-advance lottery status based on real-time schedule and seat capacities
function syncLotteryStatuses(callback) {
  const nowIso = new Date().toISOString();
  db.serialize(() => {
    // 1. Advance UPCOMING -> ACTIVE when start_time has arrived
    db.run(
      `UPDATE arena_pot_lotteries 
       SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP 
       WHERE status = 'UPCOMING' AND start_time <= ? AND end_time > ? AND sold_seats < total_seats`,
      [nowIso, nowIso]
    );

    // 2. Advance ACTIVE -> CLOSED if end_time passed or all seats are sold
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

// Admin Token Verifier (used by arena.html)
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Admin access token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || !decoded || !decoded.isAdmin) {
      return res.status(403).json({ error: 'Invalid or expired admin authorization.' });
    }
    req.admin = decoded;
    next();
  });
}

// Helper: Ensure the admin has a linked user profile for seat ownership
function getOrCreateAdminUserId(adminUsername, callback) {
  db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, user) => {
    if (user) return callback(null, user.id);

    const refCode = 'ADM_' + Math.random().toString(36).substring(2, 7).toUpperCase();
    db.run(
      `INSERT INTO users (full_name, username, email, password_hash, referral_code, balance) 
       VALUES (?, ?, ?, 'ADMIN_PROXY_PASS', ?, 100000)`,
      ['Admin Account', adminUsername, `${adminUsername}@arenagames.com`, refCode],
      function (insErr) {
        if (insErr) return callback(insErr);
        callback(null, this.lastID);
      }
    );
  });
}

// ==========================================
// USER ENDPOINTS (App Integration)
// ==========================================

// 1. Arena Pot Home: Featured, Active, Upcoming, and Recent Winners
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
      if (err) return res.status(500).json({ error: 'Failed to retrieve lotteries' });

      const winnersQuery = `
        SELECT w.id, w.winner_position, w.prize_title, w.prize_amount, w.prize_type, w.published_at,
               t.ticket_number AS winning_seat, u.username, l.title as lottery_title
        FROM arena_pot_winners w
        JOIN users u ON w.user_id = u.id
        JOIN arena_pot_tickets t ON w.ticket_id = t.id
        JOIN arena_pot_lotteries l ON w.lottery_id = l.id
        ORDER BY w.published_at DESC LIMIT 15
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

// 2. Lottery Details: Rules, Seat Availability Grid, and User's Chosen Seats
router.get('/lottery/:id', authenticateToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const userId = req.user.id;

  syncLotteryStatuses(() => {
    db.get(
      `SELECT *, (total_seats - sold_seats) AS remaining_seats 
       FROM arena_pot_lotteries WHERE id = ?`,
      [lotteryId],
      (err, lottery) => {
        if (err || !lottery) return res.status(404).json({ error: 'Lottery not found.' });

        db.all(
          `SELECT winner_position, prize_type, prize_amount, prize_title 
           FROM arena_pot_prizes WHERE lottery_id = ? ORDER BY winner_position ASC`,
          [lotteryId],
          (pErr, prizes) => {
            // Get all tickets to compute occupied and user-owned seats
            db.all(
              `SELECT ticket_number, user_id FROM arena_pot_tickets WHERE lottery_id = ? ORDER BY ticket_number ASC`,
              [lotteryId],
              (tErr, allTickets) => {
                const occupiedSeats = (allTickets || []).map((t) => t.ticket_number);
                const myTickets = (allTickets || []).filter((t) => t.user_id === userId);

                // Fetch published winning seats if lottery is completed
                db.all(
                  `SELECT w.winner_position, w.prize_title, w.prize_amount, w.prize_type,
                          t.ticket_number AS winning_seat, u.username
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
                      occupied_seats: occupiedSeats,
                      my_tickets: myTickets,
                      my_ticket_count: myTickets.length,
                      winners: winners || [],
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

// 3. Buy Specific Seat Numbers (User Choice with Atomic Concurrency Protection)
router.post('/lottery/:id/buy', authenticateToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const userId = req.user.id;
  const { selected_seats } = req.body;

  if (!Array.isArray(selected_seats) || selected_seats.length === 0) {
    return res.status(400).json({ error: 'Please choose at least one seat number.' });
  }

  // Deduplicate and parse seat numbers
  const seatNumbers = [...new Set(selected_seats.map((n) => parseInt(n, 10)))];
  const count = seatNumbers.length;

  db.serialize(() => {
    db.run('BEGIN IMMEDIATE TRANSACTION');

    db.get(`SELECT * FROM arena_pot_lotteries WHERE id = ?`, [lotteryId], (lErr, lottery) => {
      if (lErr || !lottery) {
        db.run('ROLLBACK');
        return res.status(404).json({ error: 'Lottery not found.' });
      }

      const nowIso = new Date().toISOString();
      if (lottery.status !== 'ACTIVE' || lottery.end_time <= nowIso) {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'Ticket sales are closed for this lottery.' });
      }

      // Check bounds (1 to total_seats)
      const outOfBounds = seatNumbers.find((s) => s < 1 || s > lottery.total_seats);
      if (outOfBounds) {
        db.run('ROLLBACK');
        return res.status(400).json({
          error: `Seat #${outOfBounds} is invalid. Seats must be between 1 and ${lottery.total_seats}.`,
        });
      }

      // Check user maximum seat limit
      db.get(
        `SELECT COUNT(*) as existing_count FROM arena_pot_tickets WHERE lottery_id = ? AND user_id = ?`,
        [lotteryId, userId],
        (cErr, userCountRow) => {
          const existingCount = userCountRow ? userCountRow.existing_count : 0;
          if (lottery.user_ticket_limit > 0 && existingCount + count > lottery.user_ticket_limit) {
            db.run('ROLLBACK');
            return res.status(400).json({
              error: `Maximum seat limit is ${lottery.user_ticket_limit}. You already hold ${existingCount} seat(s).`,
            });
          }

          // Check if any of these seats were already taken
          const placeholders = seatNumbers.map(() => '?').join(',');
          db.all(
            `SELECT ticket_number FROM arena_pot_tickets WHERE lottery_id = ? AND ticket_number IN (${placeholders})`,
            [lotteryId, ...seatNumbers],
            (collErr, collisionRows) => {
              if (collisionRows && collisionRows.length > 0) {
                db.run('ROLLBACK');
                const taken = collisionRows.map((r) => `#${r.ticket_number}`).join(', ');
                return res.status(400).json({
                  error: `Seat(s) ${taken} have just been taken by another player. Please pick different seats.`,
                });
              }

              const totalCost = lottery.ticket_price * count;

              // Check User Wallet Balance
              db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (uErr, user) => {
                if (uErr || !user) {
                  db.run('ROLLBACK');
                  return res.status(404).json({ error: 'User profile not found.' });
                }

                if (user.balance < totalCost) {
                  db.run('ROLLBACK');
                  return res.status(400).json({
                    error: `Insufficient coins. You have ${user.balance} coins, but ${totalCost} coins are required.`,
                  });
                }

                // Insert selected seat tickets
                const valuesSql = [];
                const params = [];
                for (const seat of seatNumbers) {
                  valuesSql.push('(?, ?, ?, ?)');
                  params.push(lotteryId, userId, seat, lottery.ticket_price);
                }

                db.run(
                  `INSERT INTO arena_pot_tickets (lottery_id, user_id, ticket_number, coin_price) VALUES ${valuesSql.join(', ')}`,
                  params,
                  function (tErr) {
                    if (tErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: 'Failed to reserve seats: ' + tErr.message });
                    }

                    const newSoldSeats = lottery.sold_seats + count;
                    const newStatus = newSoldSeats >= lottery.total_seats ? 'CLOSED' : 'ACTIVE';

                    // Update lottery sold seats count
                    db.run(
                      `UPDATE arena_pot_lotteries SET sold_seats = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                      [newSoldSeats, newStatus, lotteryId],
                      (upErr) => {
                        if (upErr) {
                          db.run('ROLLBACK');
                          return res.status(500).json({ error: 'Failed to update lottery seat count.' });
                        }

                        // Deduct user wallet balance
                        db.run(
                          `UPDATE users SET balance = balance - ? WHERE id = ?`,
                          [totalCost, userId],
                          (balErr) => {
                            if (balErr) {
                              db.run('ROLLBACK');
                              return res.status(500).json({ error: 'Failed to deduct wallet coins.' });
                            }

                            // Write transaction audit entry
                            const refId = `POT_SEATS_${lotteryId}_${Date.now()}`;
                            db.run(
                              `INSERT INTO transactions (user_id, type, amount, reference_id) 
                               VALUES (?, 'POT_TICKET_PURCHASE', ?, ?)`,
                              [userId, -totalCost, refId],
                              (txErr) => {
                                db.run('COMMIT', () => {
                                  res.json({
                                    success: true,
                                    message: `Reserved seat(s): ${seatNumbers.map((s) => `#${s}`).join(', ')}!`,
                                    booked_seats: seatNumbers,
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
                  }
                );
              });
            }
          );
        }
      );
    });
  });
});

// 4. View Participants with Bought Seats List
router.get('/lottery/:id/participants', authenticateToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const query = `
    SELECT u.id as user_id, u.username, 
           COUNT(t.id) as ticket_count, 
           SUM(t.coin_price) as total_spent,
           MIN(t.purchased_at) as joined_at,
           GROUP_CONCAT(t.ticket_number, ', ') as seat_numbers
    FROM arena_pot_tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.lottery_id = ?
    GROUP BY t.user_id
    ORDER BY ticket_count DESC, joined_at ASC
  `;

  db.all(query, [lotteryId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load participants.' });
    res.json({ success: true, participants: rows || [] });
  });
});

// 5. User's Purchased Tickets
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
    if (err) return res.status(500).json({ error: 'Failed to fetch tickets.' });
    res.json({ success: true, tickets: rows || [] });
  });
});

// 6. Complete Winners History
router.get('/winners/all', (req, res) => {
  const query = `
    SELECT w.id, w.winner_position, w.prize_title, w.prize_amount, w.prize_type, w.published_at,
           t.ticket_number AS winning_seat, u.username, l.title as lottery_title, l.id as lottery_id
    FROM arena_pot_winners w
    JOIN users u ON w.user_id = u.id
    JOIN arena_pot_tickets t ON w.ticket_id = t.id
    JOIN arena_pot_lotteries l ON w.lottery_id = l.id
    ORDER BY w.published_at DESC LIMIT 200
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load winners history.' });
    res.json({ success: true, winners: rows || [] });
  });
});

// ==========================================
// ADMIN ENDPOINTS (Powering arena.html)
// ==========================================

// Admin Login
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  db.get('SELECT * FROM admins WHERE username = ?', [username], (err, admin) => {
    if (err || !admin) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const valid = bcrypt.compareSync(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username, isAdmin: true },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      admin: { id: admin.id, username: admin.username, fullName: admin.full_name },
    });
  });
});

// Admin Dashboard Overview Statistics
router.get('/admin/stats', verifyAdminToken, (req, res) => {
  const stats = {};

  db.get(
    `SELECT 
      COUNT(*) AS total_lotteries,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_lotteries,
      SUM(CASE WHEN status = 'UPCOMING' THEN 1 ELSE 0 END) AS upcoming_lotteries,
      SUM(CASE WHEN status IN ('CLOSED', 'RESULTS_PUBLISHED', 'COMPLETED') THEN 1 ELSE 0 END) AS completed_lotteries,
      COALESCE(SUM(sold_seats), 0) AS total_tickets_sold
    FROM arena_pot_lotteries`,
    (err, row) => {
      stats.total_lotteries = row?.total_lotteries || 0;
      stats.active_lotteries = row?.active_lotteries || 0;
      stats.upcoming_lotteries = row?.upcoming_lotteries || 0;
      stats.completed_lotteries = row?.completed_lotteries || 0;
      stats.total_tickets_sold = row?.total_tickets_sold || 0;

      db.get(
        `SELECT COUNT(DISTINCT user_id) as total_participants, COALESCE(SUM(coin_price), 0) as total_revenue FROM arena_pot_tickets`,
        (tErr, tRow) => {
          stats.total_participants = tRow?.total_participants || 0;
          stats.total_revenue = tRow?.total_revenue || 0;

          db.get(
            `SELECT COALESCE(SUM(prize_amount), 0) as total_prizes_distributed, COUNT(*) as total_winners_count FROM arena_pot_winners`,
            (wErr, wRow) => {
              stats.total_prizes_distributed = wRow?.total_prizes_distributed || 0;
              stats.total_winners_count = wRow?.total_winners_count || 0;

              res.json({ success: true, stats });
            }
          );
        }
      );
    }
  );
});

// Admin Get Lotteries List
router.get('/admin/lotteries', verifyAdminToken, (req, res) => {
  const { status } = req.query;
  let sql = `
    SELECT l.*, 
           (l.total_seats - l.sold_seats) AS remaining_seats,
           (SELECT COUNT(DISTINCT user_id) FROM arena_pot_tickets WHERE lottery_id = l.id) AS participant_count
    FROM arena_pot_lotteries l
  `;
  const params = [];

  if (status && status !== 'ALL') {
    sql += ` WHERE l.status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY l.id DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch lotteries.' });
    res.json({ success: true, lotteries: rows || [] });
  });
});

// Admin Create New Lottery
router.post('/admin/create', verifyAdminToken, (req, res) => {
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
    prizes,
  } = req.body;

  if (!title || !prize_title || !total_seats || !start_time || !end_time) {
    return res.status(400).json({ error: 'Please provide all required fields.' });
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
        req.admin.id,
      ],
      function (err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to create lottery: ' + err.message });
        }

        const lotteryId = this.lastID;

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
                return res.status(500).json({ error: 'Failed to store prizes.' });
              }
              db.run('COMMIT', () => {
                res.json({ success: true, message: 'Lottery published successfully!', lottery_id: lotteryId });
              });
            }
          );
        } else {
          db.run('COMMIT', () => {
            res.json({ success: true, message: 'Lottery published successfully!', lottery_id: lotteryId });
          });
        }
      }
    );
  });
});

// Admin Update Lottery Status
router.put('/admin/lottery/:id/status', verifyAdminToken, (req, res) => {
  const { status } = req.body;
  const lotteryId = req.params.id;

  const validStatuses = ['ACTIVE', 'UPCOMING', 'PAUSED', 'CLOSED', 'CANCELLED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  db.run(
    `UPDATE arena_pot_lotteries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, lotteryId],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: `Lottery #${lotteryId} status changed to ${status}` });
    }
  );
});

// Admin Delete Draft or Empty Lottery
router.delete('/admin/lottery/:id', verifyAdminToken, (req, res) => {
  const lotteryId = req.params.id;

  db.get('SELECT sold_seats, status FROM arena_pot_lotteries WHERE id = ?', [lotteryId], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Lottery not found.' });
    if (row.sold_seats > 0) {
      return res.status(400).json({ error: 'Cannot delete lottery with tickets sold.' });
    }

    db.run('DELETE FROM arena_pot_lotteries WHERE id = ?', [lotteryId], (dErr) => {
      if (dErr) return res.status(500).json({ error: dErr.message });
      res.json({ success: true, message: 'Lottery deleted successfully.' });
    });
  });
});

// Admin Get Sold Seats / Tickets for Inspector
router.get('/admin/lottery/:id/tickets', verifyAdminToken, (req, res) => {
  const lotteryId = req.params.id;
  const sql = `
    SELECT t.id, t.ticket_number, t.coin_price, t.purchased_at,
           u.id as user_id, u.username, u.email,
           CASE WHEN w.id IS NOT NULL THEN 1 ELSE 0 END as is_winner,
           w.winner_position, w.prize_title as won_prize
    FROM arena_pot_tickets t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN arena_pot_winners w ON (t.id = w.ticket_id)
    WHERE t.lottery_id = ?
    ORDER BY t.ticket_number ASC
  `;

  db.all(sql, [lotteryId], (err, tickets) => {
    if (err) return res.status(500).json({ error: 'Failed to load tickets.' });
    res.json({ success: true, tickets: tickets || [] });
  });
});

// ---------------------------------------------------------------------------
// 7. Admin: Visual Seat Map (All seats, user seats, admin seats, winning seats)
// ---------------------------------------------------------------------------
router.get('/admin/lottery/:id/seat-map', verifyAdminToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);

  db.get('SELECT * FROM arena_pot_lotteries WHERE id = ?', [lotteryId], (err, lottery) => {
    if (err || !lottery) return res.status(404).json({ error: 'Lottery not found.' });

    db.all(
      `SELECT t.id, t.ticket_number, t.user_id, u.username,
              CASE WHEN w.id IS NOT NULL THEN 1 ELSE 0 END AS is_winner,
              w.winner_position
       FROM arena_pot_tickets t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN arena_pot_winners w ON (t.id = w.ticket_id)
       WHERE t.lottery_id = ?
       ORDER BY t.ticket_number ASC`,
      [lotteryId],
      (tErr, tickets) => {
        const ticketMap = {};
        (tickets || []).forEach((t) => {
          ticketMap[t.ticket_number] = t;
        });

        const seatMap = [];
        for (let i = 1; i <= lottery.total_seats; i++) {
          const t = ticketMap[i];
          if (!t) {
            seatMap.push({ seat: i, status: 'AVAILABLE', owner: null, is_admin: false, is_winner: false });
          } else {
            const isAdmin = t.username === req.admin.username;
            seatMap.push({
              seat: i,
              status: isAdmin ? 'ADMIN' : 'USER',
              owner: t.username,
              user_id: t.user_id,
              ticket_id: t.id,
              is_admin: isAdmin,
              is_winner: t.is_winner === 1,
              winner_position: t.winner_position || null,
            });
          }
        }

        res.json({
          success: true,
          lottery,
          seat_map: seatMap,
          total_seats: lottery.total_seats,
          sold_seats: lottery.sold_seats,
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Admin: Claim/Book Own Seat Numbers
// ---------------------------------------------------------------------------
router.post('/admin/lottery/:id/claim-seats', verifyAdminToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const { seats } = req.body; // e.g. [7, 12, 45]

  if (!Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: 'Select at least one available seat number.' });
  }

  const seatNumbers = [...new Set(seats.map((n) => parseInt(n, 10)))];

  getOrCreateAdminUserId(req.admin.username, (uErr, adminUserId) => {
    if (uErr) return res.status(500).json({ error: 'Failed to resolve admin account.' });

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION');

      db.get('SELECT * FROM arena_pot_lotteries WHERE id = ?', [lotteryId], (err, lottery) => {
        if (err || !lottery) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Lottery not found.' });
        }

        const outOfBounds = seatNumbers.find((s) => s < 1 || s > lottery.total_seats);
        if (outOfBounds) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: `Seat #${outOfBounds} is outside 1 to ${lottery.total_seats}.` });
        }

        const placeholders = seatNumbers.map(() => '?').join(',');
        db.all(
          `SELECT ticket_number FROM arena_pot_tickets WHERE lottery_id = ? AND ticket_number IN (${placeholders})`,
          [lotteryId, ...seatNumbers],
          (collErr, collisionRows) => {
            if (collisionRows && collisionRows.length > 0) {
              db.run('ROLLBACK');
              const taken = collisionRows.map((r) => `#${r.ticket_number}`).join(', ');
              return res.status(400).json({ error: `Seat(s) ${taken} are already occupied.` });
            }

            const valuesSql = [];
            const params = [];
            for (const s of seatNumbers) {
              valuesSql.push('(?, ?, ?, ?)');
              params.push(lotteryId, adminUserId, s, 0); // 0 coin price for admin reservation
            }

            db.run(
              `INSERT INTO arena_pot_tickets (lottery_id, user_id, ticket_number, coin_price) VALUES ${valuesSql.join(', ')}`,
              params,
              function (tErr) {
                if (tErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: tErr.message });
                }

                const newSold = lottery.sold_seats + seatNumbers.length;
                db.run(
                  `UPDATE arena_pot_lotteries SET sold_seats = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                  [newSold, lotteryId],
                  (upErr) => {
                    if (upErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: upErr.message });
                    }

                    db.run('COMMIT', () => {
                      res.json({
                        success: true,
                        message: `Admin claimed seat(s): ${seatNumbers.map((s) => '#' + s).join(', ')}`,
                        claimed_seats: seatNumbers,
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
});

// ---------------------------------------------------------------------------
// 9. Admin Settle & Draw Winners (Manual Chosen Seat Numbers Only)
// ---------------------------------------------------------------------------
router.post('/admin/lottery/:id/draw', verifyAdminToken, (req, res) => {
  const lotteryId = parseInt(req.params.id, 10);
  const { winning_seat, manual_winners } = req.body;

  // Support single winning seat or positional winners
  let winnersList = [];
  if (Array.isArray(manual_winners) && manual_winners.length > 0) {
    winnersList = manual_winners;
  } else if (winning_seat !== undefined && winning_seat !== null) {
    winnersList = [{ position: 1, winningSeat: parseInt(winning_seat, 10) }];
  } else {
    return res.status(400).json({ error: 'Please select a winning seat number.' });
  }

  getOrCreateAdminUserId(req.admin.username, (adminUserErr, adminUserId) => {
    if (adminUserErr) return res.status(500).json({ error: 'Failed to resolve admin identity.' });

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.get('SELECT * FROM arena_pot_lotteries WHERE id = ?', [lotteryId], (err, lottery) => {
        if (err || !lottery) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Lottery not found.' });
        }

        if (lottery.status === 'RESULTS_PUBLISHED' || lottery.status === 'COMPLETED') {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'Winner already declared for this lottery.' });
        }

        db.all(
          'SELECT * FROM arena_pot_prizes WHERE lottery_id = ? ORDER BY winner_position ASC',
          [lotteryId],
          (pErr, prizes) => {
            const prizeTiers = (prizes && prizes.length > 0)
              ? prizes
              : [{ id: null, winner_position: 1, prize_type: 'CUSTOM', prize_amount: 0, prize_title: lottery.prize_title }];

            db.all(
              `SELECT t.id, t.ticket_number, t.user_id, u.username 
               FROM arena_pot_tickets t 
               JOIN users u ON t.user_id = u.id 
               WHERE t.lottery_id = ?`,
              [lotteryId],
              (tErr, soldTickets) => {
                let ticketsPool = [...(soldTickets || [])];
                const selectedWinners = [];
                const usedSeats = new Set();

                for (const tier of prizeTiers) {
                  const target = winnersList.find((w) => w.position === tier.winner_position) || winnersList[0];
                  if (!target || !target.winningSeat) {
                    db.run('ROLLBACK');
                    return res.status(400).json({ error: `No winning seat specified for Rank #${tier.winner_position}.` });
                  }

                  const seatNum = parseInt(target.winningSeat, 10);
                  if (usedSeats.has(seatNum)) {
                    db.run('ROLLBACK');
                    return res.status(400).json({ error: `Seat #${seatNum} cannot win multiple ranks.` });
                  }

                  if (seatNum < 1 || seatNum > lottery.total_seats) {
                    db.run('ROLLBACK');
                    return res.status(400).json({ error: `Seat #${seatNum} is out of bounds (1-${lottery.total_seats}).` });
                  }

                  let ticket = ticketsPool.find((t) => t.ticket_number === seatNum);

                  // If admin chose an available seat that wasn't claimed yet, auto-assign to admin!
                  if (!ticket) {
                    db.run(
                      `INSERT INTO arena_pot_tickets (lottery_id, user_id, ticket_number, coin_price) VALUES (?, ?, ?, 0)`,
                      [lotteryId, adminUserId, seatNum],
                      function (autoInsErr) {
                        if (autoInsErr) {
                          db.run('ROLLBACK');
                          return res.status(500).json({ error: 'Failed to assign empty seat to admin.' });
                        }
                      }
                    );
                    ticket = {
                      id: null, // will be resolved or inserted
                      ticket_number: seatNum,
                      user_id: adminUserId,
                      username: req.admin.username,
                    };
                  }

                  usedSeats.add(seatNum);
                  selectedWinners.push({
                    lottery_id: lotteryId,
                    ticket_id: ticket.id,
                    user_id: ticket.user_id,
                    username: ticket.username,
                    winning_seat: seatNum,
                    winner_position: tier.winner_position,
                    prize_id: tier.id,
                    prize_title: tier.prize_title,
                    prize_type: tier.prize_type,
                    prize_amount: tier.prize_amount || 0,
                  });
                }

                // Process records sequentially
                db.all(
                  `SELECT id, ticket_number FROM arena_pot_tickets WHERE lottery_id = ?`,
                  [lotteryId],
                  (refreshErr, allUpdatedTickets) => {
                    const ticketIdMap = {};
                    (allUpdatedTickets || []).forEach((item) => {
                      ticketIdMap[item.ticket_number] = item.id;
                    });

                    for (const win of selectedWinners) {
                      const finalTicketId = win.ticket_id || ticketIdMap[win.winning_seat] || 0;

                      db.run(
                        `INSERT INTO arena_pot_winners 
                         (lottery_id, ticket_id, user_id, winner_position, prize_id, prize_title, prize_type, prize_amount)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                          win.lottery_id,
                          finalTicketId,
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

                        const refId = `POT_WIN_${lotteryId}_SEAT_${win.winning_seat}`;
                        db.run(
                          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'ARENA_POT_WIN', ?, ?)`,
                          [win.user_id, win.prize_amount, refId]
                        );
                      }
                    }

                    db.run(
                      `UPDATE arena_pot_lotteries 
                       SET status = 'RESULTS_PUBLISHED', 
                           sold_seats = (SELECT COUNT(*) FROM arena_pot_tickets WHERE lottery_id = ?), 
                           updated_at = CURRENT_TIMESTAMP 
                       WHERE id = ?`,
                      [lotteryId, lotteryId],
                      () => {
                        db.run('COMMIT', () => {
                          res.json({
                            success: true,
                            message: `Declared Winner! Winning Seat: ${selectedWinners.map((w) => `#${w.winning_seat} (@${w.username})`).join(', ')}`,
                            winners: selectedWinners,
                          });
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
  });
});

module.exports = router;
