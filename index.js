const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sftsetti-t5666-default-rtdb.firebaseio.com"
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());

// Token verify middleware
async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================
// HEALTH CHECK - ঘুমাবে না
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'alive', time: Date.now() });
});

// ============================================
// BET PLACE
// ============================================
app.post('/placeBet', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { period, betType, amount } = req.body;

    const validBets = ["Green","Red","Violet","Big","Small","0","1","2","3","4","5","6","7","8","9"];
    if (!validBets.includes(betType)) return res.status(400).json({ error: 'Invalid bet type' });
    if (!amount || amount < 5 || amount > 500000) return res.status(400).json({ error: 'Invalid amount' });
    if (!period) return res.status(400).json({ error: 'Invalid period' });

    const userRef = db.ref('users/' + uid);
    let success = false;

    await userRef.transaction((ud) => {
      if (!ud) return ud;
      if (ud.status === 'banned') return;
      const total = (ud.depositBalance || 0) + (ud.winningBalance || 0);
      if (amount > total) return;
      if ((ud.depositBalance || 0) >= amount) {
        ud.depositBalance -= amount;
      } else {
        const rem = amount - (ud.depositBalance || 0);
        ud.depositBalance = 0;
        ud.winningBalance = Math.max(0, (ud.winningBalance || 0) - rem);
      }
      success = true;
      return ud;
    });

    if (!success) return res.status(400).json({ error: 'Insufficient balance or banned' });

    const betRef = db.ref('bets/' + uid).push();
    await betRef.set({
      period, betType, amount,
      status: 'pending',
      time: Date.now(),
      uid
    });

    res.json({ success: true, betId: betRef.key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// RESOLVE BETS
// ============================================
app.post('/resolveBets', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { period, resultNumber } = req.body;

    const n = parseInt(resultNumber);
    if (isNaN(n) || n < 0 || n > 9) return res.status(400).json({ error: 'Invalid number' });

    const colorRules = {
      0: { colors: ["Red","Violet"], mul: { Red: 1.5, Violet: 4.5, num: 9 } },
      1: { colors: ["Green"], mul: { Green: 2, num: 9 } },
      2: { colors: ["Red"], mul: { Red: 2, num: 9 } },
      3: { colors: ["Green"], mul: { Green: 2, num: 9 } },
      4: { colors: ["Red"], mul: { Red: 2, num: 9 } },
      5: { colors: ["Green","Violet"], mul: { Green: 1.5, Violet: 4.5, num: 9 } },
      6: { colors: ["Red"], mul: { Red: 2, num: 9 } },
      7: { colors: ["Green"], mul: { Green: 2, num: 9 } },
      8: { colors: ["Red"], mul: { Red: 2, num: 9 } },
      9: { colors: ["Green"], mul: { Green: 2, num: 9 } },
    };

    const isBig = n >= 5;
    const rule = colorRules[n];

    const betsSnap = await db.ref('bets/' + uid)
      .orderByChild('period').equalTo(period).once('value');

    if (!betsSnap.exists()) return res.json({ success: true, totalWin: 0 });

    const updates = {};
    let totalWin = 0;

    betsSnap.forEach((child) => {
      const bet = child.val();
      if (bet.status !== 'pending') return;

      let won = false, winAmt = 0;
      const bt = bet.betType;

      if (bt === 'Big' && isBig) { won = true; winAmt = Math.round(bet.amount * 2 * 100) / 100; }
      else if (bt === 'Small' && !isBig) { won = true; winAmt = Math.round(bet.amount * 2 * 100) / 100; }
      else if (bt === 'Green' && rule.colors.includes('Green')) { won = true; winAmt = Math.round(bet.amount * (rule.mul.Green || 2) * 100) / 100; }
      else if (bt === 'Red' && rule.colors.includes('Red')) { won = true; winAmt = Math.round(bet.amount * (rule.mul.Red || 2) * 100) / 100; }
      else if (bt === 'Violet' && rule.colors.includes('Violet')) { won = true; winAmt = Math.round(bet.amount * (rule.mul.Violet || 4.5) * 100) / 100; }
      else if (bt === String(n)) { won = true; winAmt = Math.round(bet.amount * (rule.mul.num || 9) * 100) / 100; }

      updates['bets/' + uid + '/' + child.key + '/status'] = won ? 'won' : 'lost';
      updates['bets/' + uid + '/' + child.key + '/winAmt'] = winAmt;
      updates['bets/' + uid + '/' + child.key + '/resultNumber'] = n;
      updates['bets/' + uid + '/' + child.key + '/resolvedAt'] = Date.now();

      if (won) totalWin += winAmt;
    });

    await db.ref().update(updates);

    if (totalWin > 0) {
      await db.ref('users/' + uid).transaction((ud) => {
        if (!ud) return ud;
        ud.winningBalance = (ud.winningBalance || 0) + totalWin;
        return ud;
      });
    }

    res.json({ success: true, totalWin });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// WITHDRAW
// ============================================
app.post('/withdraw', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { method, amount, account } = req.body;

    if (!amount || amount < 120) return res.status(400).json({ error: 'Minimum withdrawal 120' });
    if (!account || account.length < 5) return res.status(400).json({ error: 'Invalid account' });

    const userRef = db.ref('users/' + uid);
    let success = false;

    await userRef.transaction((ud) => {
      if (!ud) return ud;
      if (ud.status === 'banned') return;
      if ((ud.winningBalance || 0) < amount) return;
      ud.winningBalance -= amount;
      success = true;
      return ud;
    });

    if (!success) return res.status(400).json({ error: 'Insufficient balance or banned' });

    const snap = await db.ref('users/' + uid).once('value');
    const userData = snap.val();

    await db.ref('withdrawals').push({
      uid,
      userUID: userData.uid || '',
      name: userData.name || '',
      method: method || '',
      amount,
      account,
      status: 'pending',
      time: Date.now()
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// APPROVE DEPOSIT — শুধু Admin
// ============================================
app.post('/approveDeposit', verifyToken, async (req, res) => {
  try {
    const adminSnap = await db.ref('users/' + req.user.uid + '/status').once('value');
    if (adminSnap.val() !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { depositId, uid, amount } = req.body;
    await db.ref('deposits/' + depositId).update({ status: 'approved', approvedAt: Date.now() });
    await db.ref('users/' + uid).transaction((ud) => {
      if (!ud) return ud;
      ud.depositBalance = (ud.depositBalance || 0) + amount;
      return ud;
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// APPROVE WITHDRAW — শুধু Admin
// ============================================
app.post('/approveWithdraw', verifyToken, async (req, res) => {
  try {
    const adminSnap = await db.ref('users/' + req.user.uid + '/status').once('value');
    if (adminSnap.val() !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { withdrawId } = req.body;
    await db.ref('withdrawals/' + withdrawId).update({ status: 'approved', approvedAt: Date.now() });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
