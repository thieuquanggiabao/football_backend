require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const express = require('express');
const { PayOS } = require('@payos/node');
// ==========================================
// KHU VỰC 1: KHỞI TẠO BIẾN TOÀN CỤC
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const FOOTBALL_API_TOKEN = process.env.FOOTBALL_API_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;
const LEAGUES = ['PL', 'PD', 'BL1', 'SA', 'FL1']; // 5 giải hàng đầu Châu Âu

// Khởi tạo PayOS
const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID,
    apiKey: process.env.PAYOS_API_KEY,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY
});
// ==========================================
// KHU VỰC 2: CÁC HÀM XỬ LÝ (SĂN TIN, TỈ SỐ, BXH)
// ==========================================

// 1. Hàm đồng bộ Tỉ số trực tiếp
async function syncLiveMatches() {
    try {
        console.log('Đang lấy dữ liệu bóng đá từ football-data.org...');
        const response = await axios.get('https://api.football-data.org/v4/matches', {
            headers: { 'X-Auth-Token': FOOTBALL_API_TOKEN }
        });
        const matches = response.data.matches;

        if (!matches || matches.length === 0) {
            console.log('Hôm nay không có trận đấu nào thuộc các giải được hỗ trợ.');
            return;
        }

        const matchDataToUpsert = matches.map(match => ({
            api_match_id: match.id,
            home_team: match.homeTeam.name,
            away_team: match.awayTeam.name,
            home_score: match.score?.fullTime?.home ?? 0,
            away_score: match.score?.fullTime?.away ?? 0,
            home_logo: match.homeTeam.crest ?? '',
            away_logo: match.awayTeam.crest ?? '',
            status: match.status,
            started_at: match.utcDate,
            updated_at: new Date().toISOString(),
            league_code: match.competition?.code ?? 'UNKNOWN'
        }));

        const { error } = await supabase.from('live_matches').upsert(matchDataToUpsert, { onConflict: 'api_match_id' });
        if (error) console.error('Lỗi khi lưu Live Match:', error);
        else console.log(`[${new Date().toLocaleTimeString()}] Đã cập nhật ${matchDataToUpsert.length} trận trực tiếp!`);
    } catch (error) {
        console.error('Lỗi API Live Match:', error.message);
    }
}

// 2. Hàm săn Tin tức Bóng đá
async function fetchAndSaveNews() {
    try {
        console.log('Bắt đầu đi săn tin tức bóng đá...');
        const keyword = encodeURIComponent('football');
        const apiUrl = `https://newsdata.io/api/1/news?apikey=${NEWS_API_KEY}&q=${keyword}&category=sports&language=vi`;

        const response = await axios.get(apiUrl);
        const articles = response.data.results;

        if (!articles || articles.length === 0) {
            console.log('Không có tin tức bóng đá mới nào.');
            return;
        }

        const newsData = articles.map(article => ({
            title: article.title,
            description: article.description || 'Bấm vào để xem chi tiết bài viết...',
            image_url: article.image_url || 'https://via.placeholder.com/400x200?text=Football+News',
            article_url: article.link,
            published_at: article.pubDate
        }));

        const { error } = await supabase.from('news').upsert(newsData, { onConflict: 'article_url' });
        if (error) throw error;
        console.log(`✅ Đã cất thành công ${newsData.length} bài báo BÓNG ĐÁ vào kho!`);
    } catch (error) {
        console.error('❌ Lỗi khi lấy tin tức:', error.message);
    }
}

// 3. Hàm đồng bộ Bảng xếp hạng
async function fetchAndSaveStandings() {
    console.log('Bắt đầu đồng bộ Bảng xếp hạng...');
    for (const leagueCode of LEAGUES) {
        try {
            const response = await axios.get(`https://api.football-data.org/v4/competitions/${leagueCode}/standings`, {
                headers: { 'X-Auth-Token': FOOTBALL_API_TOKEN }
            });
            const totalStanding = response.data.standings.find(s => s.type === 'TOTAL');
            if (!totalStanding) continue;

            const recordsToUpsert = totalStanding.table.map(row => ({
                league_code: leagueCode,
                position: row.position,
                team_id: row.team.id,
                team_name: row.team.shortName || row.team.name,
                team_logo: row.team.crest,
                played: row.playedGames,
                won: row.won,
                draw: row.draw,
                lost: row.lost,
                points: row.points,
                goals_for: row.goalsFor,
                goals_against: row.goalsAgainst,
                goal_difference: row.goalDifference,
                updated_at: new Date().toISOString()
            }));

            const { error } = await supabase.from('standings').upsert(recordsToUpsert, { onConflict: 'league_code, team_id' });
            if (error) console.error(`Lỗi lưu giải ${leagueCode}:`, error.message);
            else console.log(`✅ Đã cập nhật xong BXH giải ${leagueCode}!`);

            await new Promise(resolve => setTimeout(resolve, 2000)); // Nghỉ 2s tránh bị API khóa
        } catch (error) {
            console.error(`❌ Lỗi tải giải ${leagueCode}:`, error.message);
        }
    }
}
// ==========================================
// PAYOS: CÁC ROUTE THANH TOÁN (ĐÃ VÁ LỖI)
// ==========================================

// Tạo link thanh toán Premium
app.post('/api/create-payment', async (req, res) => {
    // 1. Nhận trực tiếp amount và planName từ App Flutter gửi lên
    const { userId, packageType, planName, amount } = req.body;

    if (!userId || !packageType || !amount) {
        return res.status(400).json({ success: false, message: 'Thiếu dữ liệu gửi lên từ App' });
    }

    // 2. Dùng chính tên gói từ Flutter làm mô tả (giới hạn 25 ký tự theo luật PayOS)
    const description = planName.substring(0, 25);

    // 3. Tạo mã đơn hàng (số nguyên)
    const orderCode = Number(String(Date.now()).slice(-9));

    try {
        // Lưu giao dịch vào Database (Trạng thái pending)
        const { error: dbError } = await supabase.from('transactions').insert({
            order_id: orderCode,
            user_id: userId,
            amount: amount, // Lấy đúng số tiền lưu vào DB
            status: 'pending'
        });

        if (dbError) {
            console.error("🚨 LỖI SUPABASE:", dbError);
            throw new Error('Lỗi DB: ' + dbError.message);
        }
        const expiredAt = Math.floor(Date.now() / 1000) + (15 * 60);
        // Gọi PayOS với giá trị ĐỘNG
        const payment = await payos.paymentRequests.create({
            orderCode: orderCode,
            amount: amount,             // Truyền 2000đ cho PayOS
            description: description,   // Truyền "NHA Pro" cho PayOS
            expiredAt: expiredAt,
            returnUrl: 'footballapp://payment-success',
            cancelUrl: 'footballapp://payment-cancel',
            items: [{ name: description, quantity: 1, price: amount }]
        });

        res.json({
            success: true,
            paymentUrl: payment.checkoutUrl,
            orderCode: payment.orderCode
        });
    } catch (error) {
        console.error('❌ Lỗi tạo link thanh toán:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Webhook nhận kết quả thanh toán từ PayOS
app.post('/api/webhook', async (req, res) => {
    try {
        console.log("==> NHẬN WEBHOOK GIAO DỊCH TỪ PAYOS:", req.body);
        
        // Khôi phục lại lệnh nhận dữ liệu linh hoạt (kể cả khi thư viện thiếu version verify method)
        let webhookData;
        if (typeof payos.verifyPaymentWebhookData === 'function') {
            webhookData = payos.verifyPaymentWebhookData(req.body);
        } else if (payos.webhooks && typeof payos.webhooks.verify === 'function') {
            webhookData = payos.webhooks.verify(req.body);
        }

        // Ưu tiên fallback nhặt trực tiếp từ req.body.data
        const orderCodeRaw = req.body.data?.orderCode || webhookData?.orderCode;

        // Tiến hành ghi nhận nếu có mã thanh toán
        if (orderCodeRaw) {
            // Ép kiểu sang chuỗi để đối chiếu bảng transactions có order_id là (text)
            const orderCodeStr = String(orderCodeRaw);
            console.log(`✅ PayOS báo tiền về cho đơn: ${orderCodeStr}`);

            // 1. Tìm userId và amount thông qua orderCode đã lưu lúc nãy
            const { data: tx, error: txError } = await supabase
                .from('transactions')
                .select('user_id, amount')
                .eq('order_id', orderCodeStr)
                .single();

            if (txError || !tx) {
                console.error('❌ Không tìm thấy đơn hàng trong Database!');
                return res.json({ success: true }); // Vẫn trả về true để PayOS không gửi lại tin nhắn nữa
            }

            const userId = tx.user_id;
            const txAmount = tx.amount;

            // 2. Cập nhật bảng 'transactions' thành công
            await supabase.from('transactions').update({ status: 'success' }).eq('order_id', orderCodeStr);

            // 3. Phân rã gói theo số chi phí thanh toán do bảng transactions đã xoá cột plan_code
            let planCode = 'UNKNOWN';
            let unlockedLeagues = [];
            switch (txAmount) {
                case 299000: planCode = 'NHA_PRO'; unlockedLeagues = ['PL']; break;
                case 199000: planCode = 'LALIGA_PRO'; unlockedLeagues = ['PD']; break;
                case 149000: planCode = 'BUNDESLIGA_PRO'; unlockedLeagues = ['BL1']; break;
                case 2000: planCode = 'SERIA_PRO'; unlockedLeagues = ['SA']; break;
                case 699000: planCode = 'SUPER_PRO'; unlockedLeagues = ['PL', 'PD', 'BL1', 'SA', 'FL1']; break;
            }

            const expireDate = new Date();
            expireDate.setFullYear(expireDate.getFullYear() + 1); // Đã chuyển thành 1 năm (365 ngày)

            // 4. Nâng cấp VIP (Update thẳng vào bảng profiles với expire_date và unlocked_leagues)
            const { error: upgradeError } = await supabase
                .from('profiles')
                .update({
                    is_premium: true,
                    plan_code: planCode,
                    unlocked_leagues: unlockedLeagues,
                    expire_date: expireDate.toISOString(),
                    premium_since: new Date().toISOString()
                })
                .eq('id', userId);

            if (upgradeError) console.error('❌ Lỗi cập nhật Premium vào profiles:', upgradeError);
            else console.log(`🎉 User ${userId} đã được cấu hình cấp Premium (${planCode}) thành công!`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.status(400).json({ success: false });
    }
});
// ==========================================
// KHU VỰC 3: CÁC CỔNG GIAO TIẾP (API ROUTES)
// ==========================================

app.get('/', (req, res) => {
    res.send('ok');
});

app.get('/ping', (req, res) => {
    res.status(200).send('ok');
});

app.get('/api/teams/:id', async (req, res) => {
    const teamId = req.params.id;
    try {
        const { data: existingTeam } = await supabase.from('team_profiles').select('profile_data').eq('team_id', teamId).single();
        if (existingTeam && existingTeam.profile_data) {
            return res.json(existingTeam.profile_data);
        }

        const response = await axios.get(`https://api.football-data.org/v4/teams/${teamId}`, {
            headers: {
                'X-Auth-Token': FOOTBALL_API_TOKEN,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json'
            }
        });

        await supabase.from('team_profiles').upsert({
            team_id: teamId,
            profile_data: response.data,
            updated_at: new Date().toISOString()
        });

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Không thể tải dữ liệu đội bóng' });
    }
});

// ==========================================
// KHU VỰC 4: LÊN LỊCH CHẠY VÀ MỞ SERVER
// ==========================================

// Chạy thử ngay khi khởi động
syncLiveMatches();
fetchAndSaveNews();
fetchAndSaveStandings();
//setTimeout(fetchAndSaveTeamNews, 10000);
// Đặt chuông báo thức
setInterval(syncLiveMatches, 60 * 1000); // 1 phút / lần
cron.schedule('0 */2 * * *', fetchAndSaveStandings); // 2 tiếng / lần
cron.schedule('0 */1 * * *', fetchAndSaveNews); // 1 tiếng / lần

app.listen(port, () => {
    console.log(`🚪 Cánh cửa đã được mở tại cổng số ${port}`);
});
// Robot dọn dẹp đơn hàng rác (Chạy 15 phút một lần)
cron.schedule('*/15 * * * *', async () => {
    try {
        console.log('🧹 Đang dọn dẹp các đơn hàng pending quá hạn...');

        // Lấy mốc thời gian 15 phút trước
        const cutoffTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();

        // Xóa hẳn các đơn hàng vẫn đang 'pending' mà được tạo từ trước mốc thời gian kia
        const { data, error } = await supabase
            .from('transactions')
            .delete()
            .eq('status', 'pending')
            .lt('created_at', cutoffTime);
        // .lt nghĩa là "less than" (nhỏ hơn/cũ hơn mốc cutoffTime)

        if (error) throw error;
        console.log('✅ Đã dọn sạch các giao dịch rác!');
    } catch (error) {
        console.error('❌ Lỗi dọn dẹp Database:', error.message);
    }
});