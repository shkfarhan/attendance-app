"use server";
import { adminDb } from "@/lib/firebase-admin";
import { format } from "date-fns";
import ExcelJS from "exceljs";
import { toZonedTime } from "date-fns-tz";

const TIME_ZONE = "Asia/Kolkata";

export async function generateMonthlyReport(year?: number, month?: number, targetUid?: string) {
    try {
        const wb = new ExcelJS.Workbook();

        // 1. Calculate Date Range (21st Prev Month -> 20th Curr Month)
        const now = new Date();
        const targetYear = year || now.getFullYear();
        const targetMonth = month !== undefined ? month : now.getMonth(); // 0-indexed (0=Jan)

        const startDate = new Date(targetYear, targetMonth - 1, 21);
        const endDate = new Date(targetYear, targetMonth, 20);

        // Fetch Holidays Map
        const holidaysStart = format(startDate, "yyyy-MM-dd");
        const holidaysEnd = format(endDate, "yyyy-MM-dd");

        const holidaysSnap = await adminDb.collection("holidays")
            .where("date", ">=", holidaysStart)
            .where("date", "<=", holidaysEnd)
            .get();

        const holidayMap: Record<string, { name: string, type: string }> = {};
        holidaysSnap.forEach(doc => {
            holidayMap[doc.id] = doc.data() as any;
        });

        // Generate array of date objects involved
        const days: { date: Date, dateStr: string, dayName: string, isSunday: boolean }[] = [];
        let cur = new Date(startDate);
        while (cur <= endDate) {
            days.push({
                date: new Date(cur),
                dateStr: format(cur, "yyyy-MM-dd"), // Matches Firestore ID
                dayName: format(cur, "EEE"),
                isSunday: cur.getDay() === 0
            });
            cur.setDate(cur.getDate() + 1);
        }

        // 2. Fetch Users
        let users: { uid: string, name: string, email: string }[] = [];

        if (targetUid) {
            const userDoc = await adminDb.collection("users").doc(targetUid).get();
            if (userDoc.exists) {
                const d = userDoc.data();
                users.push({ uid: userDoc.id, name: d?.name || "Employee", email: d?.email });
            }
        } else {
            const usersSnap = await adminDb.collection("users").orderBy("name").get();
            users = usersSnap.docs.map(doc => ({ uid: doc.id, name: doc.data().name || "Unknown", email: doc.data().email }));
        }

        for (const user of users) {
            const safeName = (user.name || "Employee").replace(/[*?:/\[\]\\]/g, "");
            const ws = wb.addWorksheet(safeName);

            ws.columns = [
                { header: "Date", key: "date", width: 15 },
                { header: "Day", key: "day", width: 10 },
                { header: "Punch In", key: "in", width: 15 },
                { header: "Punch Out", key: "out", width: 15 },
                { header: "Late (min)", key: "late", width: 10 },
                { header: "Overtime (min)", key: "ot", width: 15 },
                { header: "Status", key: "status", width: 20 },
            ];

            const refs = days.map(d => adminDb.collection("attendance").doc(`${user.uid}_${d.dateStr}`));
            const snaps = await adminDb.getAll(...refs);

            days.forEach((day, index) => {
                const doc = snaps[index];
                const rowData: any = {
                    date: day.dateStr,
                    day: day.dayName,
                    in: "-",
                    out: "-",
                    late: 0,
                    ot: 0,
                    status: ""
                };

                let isYellow = false; // Holiday/Sunday
                let isRed = false;    // Absent
                let isOrange = false; // Half Day
                let isGreen = false;  // Overtime

                // 1. Determine Day Type
                let isHoliday = day.isSunday; // Sunday default
                let holidayName = "Sunday";

                // Saturday Logic (Default: 2nd & 4th = Holiday)
                if (day.dayName === "Sat") {
                    const d = day.date.getDate();
                    const weekNum = Math.ceil(d / 7);
                    if (weekNum === 2 || weekNum === 4) {
                        isHoliday = true;
                        holidayName = "Saturday Holiday";
                    }
                }

                // Custom Holiday Override
                if (holidayMap[day.dateStr]) {
                    const h = holidayMap[day.dateStr];
                    if (h.type === "working") {
                        isHoliday = false; // Force working
                    } else {
                        isHoliday = true;
                        holidayName = h.name || "Holiday";
                    }
                }

                // Default Status
                if (isHoliday) rowData.status = holidayName;
                else rowData.status = "Absent";

                // 2. Check Attendance
                if (doc.exists) {
                    const data = doc.data();
                    if (data) {
                        // Fix Timezone for Display
                        if (data.punchIn) {
                            const inDate = toZonedTime(data.punchIn.time.toDate(), TIME_ZONE);
                            rowData.in = format(inDate, "hh:mm a");
                        }
                        if (data.punchOut) {
                            const outDate = toZonedTime(data.punchOut.time.toDate(), TIME_ZONE);
                            rowData.out = format(outDate, "hh:mm a");
                        }

                        rowData.late = data.lateMinutes || 0;
                        rowData.ot = data.overtimeMinutes || 0;
                        rowData.status = data.status || "Present";

                        // Status Colors
                        if (rowData.status === "Half Day") isOrange = true;

                        // Overtime Logic for Saturdays/Holidays
                        if (isHoliday) {
                            isGreen = true;
                            // If working on a Holiday, indicate it
                            rowData.status = `${holidayName} (Worked)`;
                        } else if (rowData.ot > 0) {
                            isGreen = true;
                        }

                        if (rowData.status === "Absent") isRed = true;
                    }
                } else {
                    // No Record
                    if (isHoliday) {
                        isYellow = true;
                    } else {
                        isRed = true; // Absent on Working Day
                    }
                }

                const row = ws.addRow(rowData);

                // Apply Styles
                let bgColor = '';
                let fontColor = '';

                if (isGreen) {
                    bgColor = 'FFC6EFCE'; // Light Green
                    fontColor = '006100'; // Dark Green
                } else if (isOrange) {
                    bgColor = 'FFFFEB9C'; // Light Orange
                    fontColor = '9C5700'; // Dark Orange
                } else if (isRed) {
                    bgColor = 'FFFFC7CE'; // Light Red
                    fontColor = '9C0006'; // Dark Red
                } else if (isYellow) {
                    bgColor = 'FFFFFF00'; // Bright Yellow
                }

                if (bgColor) {
                    row.eachCell((cell) => {
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: bgColor }
                        };
                        if (fontColor) {
                            cell.font = { color: { argb: fontColor } };
                        }
                    });
                }
            });
        }

        const buffer = await wb.xlsx.writeBuffer();

        // Dynamic Filename
        let filename = `Attendance_Report_${format(startDate, "MMM_dd")}_to_${format(endDate, "MMM_dd")}.xlsx`;
        if (targetUid && users.length > 0) {
            filename = `${users[0].name.replace(/\s+/g, '_')}_Attendance_${format(startDate, "MMM")}.xlsx`;
        }

        return {
            success: true,
            data: Buffer.from(buffer).toString('base64'),
            filename: filename
        };

    } catch (e: any) {
        console.error("Export Error:", e);
        return { success: false, error: e.message };
    }
}
