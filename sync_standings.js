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
    process.exit(); // Chạy xong tự động tắt script
}

fetchAndSaveStandings();