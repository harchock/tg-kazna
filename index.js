const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const bot = new Telegraf('');
const db = new sqlite3.Database('treasury.db');
const adminId = ;
const paymentsChannelId = '';

const paymentSessions = {};
const monthlyFee = 25;
let treasuryBalance = 0;
let lastBalanceScreenshot = './balance.png';

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            balance INTEGER DEFAULT 0,
            last_payment_date TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount INTEGER,
            payment_date TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);
});

const addOrUpdateUser = (userId, username, firstName, lastName) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, row) => {
        if (row) {
            db.run(`UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE id = ?`, [username, firstName, lastName, userId]);
        } else {
            db.run(`INSERT INTO users (id, username, first_name, last_name) VALUES (?, ?, ?, ?)`, [userId, username, firstName, lastName]);
        }
    });
};

bot.start((ctx) => {
    const { id, username, first_name, last_name } = ctx.message.from;
    addOrUpdateUser(id, username, first_name, last_name);

    const commonButtons = [['Мій Баланс', 'Оплатити казну'], ['Реквізити', 'СС звіт'], ['Баланс Казни']];
    const adminButtons = [['Оновити Баланс Казни', 'Список користувачів']];

    const buttons = id === adminId 
        ? [...commonButtons, ...adminButtons] 
        : commonButtons;

    ctx.reply(
        `Привіт, ${first_name}!\nОсь доступні команди:`,
        Markup.keyboard(buttons).resize()
    );
});

bot.hears('Мій Баланс', (ctx) => {
    const userId = ctx.message.from.id;
    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, row) => {
        if (row) {
            ctx.reply(`Ваш поточний баланс: ${row.balance} грн. Поточний тариф: 25 грн/місяць.`);
        } else {
            ctx.reply('Користувача не знайдено.');
        }
    });
});

bot.hears('Баланс Казни', (ctx) => {
    if (fs.existsSync('./treasury_balance.txt')) {
        treasuryBalance = parseFloat(fs.readFileSync('./treasury_balance.txt', 'utf-8'));

        if (fs.existsSync('./balance_id.txt')) {
            lastBalanceScreenshot = fs.readFileSync('./balance_id.txt', 'utf-8');
        }

        ctx.replyWithPhoto(lastBalanceScreenshot, {
            caption: `Баланс казни: ${treasuryBalance} грн.`
        });
    } else {
        ctx.reply('Баланс казни ще не завантажено.');
    }
});

bot.hears('Оплатити казну', (ctx) => {
    const userId = ctx.message.from.id;
    paymentSessions[userId] = { awaitingScreenshot: true };
    ctx.reply('Надішліть скріншот оплати.');
});

bot.on('photo', async (ctx) => {
    const userId = ctx.message.from.id;
    if (paymentSessions[userId] && paymentSessions[userId].awaitingScreenshot) {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        paymentSessions[userId].screenshotFileId = fileId;
        paymentSessions[userId].awaitingAmount = true;
        delete paymentSessions[userId].awaitingScreenshot;

        ctx.reply('Скріншот отримано. Введіть суму платежу (наприклад: 50 грн).');
    }
});

bot.on('text', async (ctx) => {
    const userId = ctx.message.from.id;
    const message = ctx.message.text.trim();

    if (paymentSessions[userId] && paymentSessions[userId].awaitingAmount) {
        const amount = parseFloat(message);
        if (!isNaN(amount)) {
            db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, row) => {
                if (row) {
                    const newBalance = row.balance + amount;
                    db.run(`UPDATE users SET balance = ?, last_payment_date = datetime('now') WHERE id = ?`, [newBalance, userId], (err) => {
                        if (err) {
                            ctx.reply('Сталася помилка при оновленні балансу.');
                        } else {
                            ctx.reply(`Дякуємо! Ваш баланс поповнено на ${amount} грн. Поточний баланс: ${newBalance} грн.`);

                            const fileId = paymentSessions[userId].screenshotFileId;
                            bot.telegram.sendPhoto(paymentsChannelId, fileId, {
                                caption: `Користувач ${ctx.message.from.first_name} ${ctx.message.from.last_name || ''} оплатив казну на суму ${amount} грн.`
                            });

                            delete paymentSessions[userId];
                        }
                    });
                }
            });
        } else {
            ctx.reply('Будь ласка, введіть коректну суму.');
        }
    }
});

bot.hears('Список користувачів', (ctx) => {
    if (ctx.message.from.id === adminId) {
        db.all(`SELECT * FROM users`, (err, rows) => {
            if (err) {
                ctx.reply('Помилка при отриманні даних користувачів.');
            } else if (rows.length > 0) {
                let userList = 'Список користувачів:\n';
                rows.forEach(row => {
                    userList += `${row.first_name} ${row.last_name} (Username: ${row.username}) - Баланс: ${row.balance} грн\n`;
                });
                ctx.reply(userList);
            } else {
                ctx.reply('Немає користувачів у базі даних.');
            }
        });
    } else {
        ctx.reply('У вас немає доступу до цієї команди.');
    }
});

bot.on('text', (ctx) => {
    ctx.reply('Немає такої команди. Будь ласка, використовуйте кнопки для вибору команд.');
});

const remindUsers = () => {
    db.all(`SELECT * FROM users WHERE balance < ?`, [monthlyFee], (err, rows) => {
        rows.forEach(user => {
            bot.telegram.sendMessage(user.id, 'Нагадуємо, що вам потрібно оплатити казну. Поточний баланс: ' + user.balance + ' грн.');
        });
    });
};

setInterval(remindUsers, 86400 * 1000);

bot.launch();
