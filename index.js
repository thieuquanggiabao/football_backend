require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// 1. Giữ nguyên thông tin Supabase của bạn ở đây
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Điền API Token mới lấy từ Email vào đây
const FOOTBALL_API_TOKEN = process.env.FOOTBALL_API_TOKEN;

// Cấu hình gọi API của football-data.org (Lấy toàn bộ trận đấu trong ngày hôm nay)
const options = {
    method: 'GET',
    url: 'https://api.football-data.org/v4/matches',
    headers: {
        'X-Auth-Token': FOOTBALL_API_TOKEN
    }
};

async function syncLiveMatches() {
    try {
        console.log('Đang lấy dữ liệu bóng đá từ football-data.org...');

        const response = await axios.request(options);
        const matches = response.data.matches;

        if (!matches || matches.length === 0) {
            console.log('Hôm nay không có trận đấu nào thuộc các giải được hỗ trợ.');
            return;
        }

        // 3. Xử lý và lọc dữ liệu đẩy lên Supabase
        const matchDataToUpsert = matches.map(match => {
            // football-data.org lưu điểm ở dạng match.score.fullTime.home
            // Dấu ? giúp tránh lỗi nếu trận đấu chưa đá (chưa có điểm)
            const homeScore = match.score?.fullTime?.home ?? 0;
            const awayScore = match.score?.fullTime?.away ?? 0;

            return {
                api_match_id: match.id,
                home_team: match.homeTeam.name,
                away_team: match.awayTeam.name,
                home_score: homeScore,
                away_score: awayScore,
                home_logo: match.homeTeam.crest ?? '',
                away_logo: match.awayTeam.crest ?? '',
                status: match.status, // Các trạng thái: 'TIMED' (chưa đá), 'IN_PLAY' (đang đá), 'FINISHED' (đã xong)...
                started_at: match.utcDate,
                updated_at: new Date().toISOString()
            };
        });

        // 4. Đẩy vào Database
        const { error } = await supabase
            .from('live_matches')
            .upsert(matchDataToUpsert, { onConflict: 'api_match_id' });

        if (error) {
            console.error('Lỗi khi lưu vào Supabase:', error);
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] Đã cập nhật thành công ${matchDataToUpsert.length} trận đấu!`);
        }
    } catch (error) {
        console.error('Đã xảy ra lỗi khi gọi API:', error.message);
    }
}

// Chạy hàm ngay lập tức lần đầu tiên
syncLiveMatches();

// Thiết lập vòng lặp cứ 60 giây (1 phút) chạy 1 lần an toàn
setInterval(syncLiveMatches, 60 * 1000);
// Đồng hồ báo thức: Cứ mỗi 2 tiếng (ở phút số 0) sẽ tự động chạy đoạn code bên trong
cron.schedule('0 */2 * * *', async () => {
    console.log('⏰ Bắt đầu đồng bộ Bảng xếp hạng tự động...');
    const axios = require('axios');
    const { createClient } = require('@supabase/supabase-js');

    // 1. Cấu hình chìa khóa (Thay bằng key thật của bạn)
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    const FOOTBALL_API_TOKEN = process.env.FOOTBALL_API_TOKEN;

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // 2. Danh sách mã 5 giải đấu hàng đầu Châu Âu
    const LEAGUES = ['PL', 'PD', 'BL1', 'SA', 'FL1'];

    async function fetchAndSaveStandings() {
        console.log('Bắt đầu đồng bộ Bảng xếp hạng...');

        for (const leagueCode of LEAGUES) {
            try {
                console.log(`Đang lấy dữ liệu giải ${leagueCode}...`);

                // Gọi API lấy BXH của từng giải
                const response = await axios.get(`https://api.football-data.org/v4/competitions/${leagueCode}/standings`, {
                    headers: { 'X-Auth-Token': FOOTBALL_API_TOKEN }
                });

                // Tìm BXH Tổng (TOTAL) trong cục dữ liệu trả về
                const totalStanding = response.data.standings.find(s => s.type === 'TOTAL');
                if (!totalStanding) continue;

                // Nhào nặn dữ liệu để ép vào khuôn của Supabase
                const recordsToUpsert = totalStanding.table.map(row => ({
                    league_code: leagueCode,
                    position: row.position,
                    team_id: row.team.id,
                    team_name: row.team.shortName || row.team.name, // Ưu tiên tên ngắn cho đẹp
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

                // Đẩy mạnh toàn bộ BXH của giải này lên Supabase
                const { data, error } = await supabase
                    .from('standings')
                    .upsert(recordsToUpsert, { onConflict: 'league_code, team_id' });

                if (error) {
                    console.error(`Lỗi lưu giải ${leagueCode}:`, error.message);
                } else {
                    console.log(`✅ Đã cập nhật xong BXH giải ${leagueCode}!`);
                }

                // TẠM DỪNG 2 GIÂY TRƯỚC KHI GỌI GIẢI TIẾP THEO
                // (Mẹo sinh tồn: API miễn phí cấm gọi quá nhanh, ta phải giả vờ cho máy nghỉ ngơi)
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`❌ Lỗi tải giải ${leagueCode}:`, error.message);
            }
        }

        console.log('🎉 HOÀN TẤT ĐỒNG BỘ TẤT CẢ BẢNG XẾP HẠNG!');
    }

    fetchAndSaveStandings();
    // (Nhớ bỏ dòng process.exit() đi nhé, vì chúng ta không muốn tắt app)
});