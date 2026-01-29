"use server";

import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { getDistanceFromLatLonInMeters, GRACE_PERIOD_MINUTES, OFFICE_END_HOUR, OFFICE_START_HOUR, OFFICE_START_MINUTE, MAX_DISTANCE_METERS } from "@/lib/utils";
import { Timestamp } from "firebase-admin/firestore";
import { format } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

const OFFICE_LAT = parseFloat(process.env.NEXT_PUBLIC_OFFICE_LAT || "0");
const OFFICE_LNG = parseFloat(process.env.NEXT_PUBLIC_OFFICE_LNG || "0");
const TIME_ZONE = "Asia/Kolkata"; // IST

export async function punchIn(idToken: string, lat: number, lng: number) {
    try {
        // 1. Verify Token
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Fetch User Details for consistent Name/Email
        const userDoc = await adminDb.collection("users").doc(uid).get();
        const userData = userDoc.data();
        const userName = userData?.name || decodedToken.name || "Employee";
        const userEmail = userData?.email || decodedToken.email || "No Email";
        const shiftStart = userData?.shift || "10:00"; // Default 10:00 if not set

        // Assuming 9 hours working time for everyone for now or derive from shift.
        // If 10:00 -> 19:00 (7 PM). If 10:30 -> 19:30 (7:30 PM).

        // Determine Shift Config
        let startHour = 10;
        let startMin = 0;
        if (shiftStart.includes(":")) {
            const parts = shiftStart.split(":");
            startHour = parseInt(parts[0]);
            startMin = parseInt(parts[1]);
        }

        const isRegularShift = (startHour === 10 && startMin === 0);
        const currentGracePeriod = isRegularShift ? 10 : 0; // Only 10:00 AM gets 10 mins grace. Others 0.

        let shiftDurationHours = 9;
        if (startHour === 13) {
            shiftDurationHours = 6.5; // 1:00 PM - 7:30 PM (6.5 Hours)
        } else if (startHour === 10 && startMin === 30) {
            shiftDurationHours = 9; // 10:30 - 7:30 (9 Hours)
        }

        // 2. Validate Location
        if (!OFFICE_LAT || !OFFICE_LNG) {
            throw new Error("Office location not configured.");
        }
        const distance = getDistanceFromLatLonInMeters(lat, lng, OFFICE_LAT, OFFICE_LNG);
        if (distance > MAX_DISTANCE_METERS) {
            throw new Error(`You are ${Math.round(distance)}m away from office. Must be within ${MAX_DISTANCE_METERS}m.`);
        }

        // 3. Time Calculations (Strictly Server & Timezone Aware)
        const now = new Date(); // Current Server Time (UTC)
        const zonedNow = toZonedTime(now, TIME_ZONE);
        const todayStr = format(zonedNow, "yyyy-MM-dd");

        // Check double punch
        const recordRef = adminDb.collection("attendance").doc(`${uid}_${todayStr}`);
        const recordSnap = await recordRef.get();
        if (recordSnap.exists) {
            throw new Error("Already punched in for today.");
        }

        // Calculate Standard Times in UTC for today
        // Calculate Standard Times in UTC for today using User Shift
        const officeStartStr = `${todayStr} ${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00`;
        const officeStartUTC = fromZonedTime(officeStartStr, TIME_ZONE);

        const graceEndUTC = new Date(officeStartUTC.getTime() + currentGracePeriod * 60000);

        // Calculate Late
        let lateMinutes = 0;
        // Only calculate late if NOW > Grace End.
        // If they come early (e.g. 10:28 for 10:30 start), NOW < OfficeStartUTC < GraceEndUTC.
        // So this condition handles early arrival correctly (lateMinutes remains 0).
        if (now > graceEndUTC) {
            const diffMs = now.getTime() - officeStartUTC.getTime();
            lateMinutes = Math.floor(diffMs / 60000);
        }

        // Calculate Required Punch Out (Shift Start + 9 hours + Late Minutes)
        // "must be within 9 hours" usually implies 9 hours from start time? 
        // Or 9 hours from Actual Punch In? 
        // Previous logic: "Office End + Late Minutes". Office End was fixed 7 PM. 
        // If Office Start 10:00 -> End 19:00. 
        // Now dynamic: Start + 9 Hours.
        const officeEndUTC = new Date(officeStartUTC.getTime() + (shiftDurationHours * 60 * 60 * 1000));

        const requiredPunchOutUTC = new Date(officeEndUTC.getTime() + lateMinutes * 60000);

        // 4. Save to Firestore
        await recordRef.set({
            uid,
            date: todayStr,
            punchIn: {
                time: Timestamp.fromDate(now),
                lat,
                lng
            },
            punchOut: null,
            requiredPunchOut: Timestamp.fromDate(requiredPunchOutUTC),
            lateMinutes,
            status: "Working", // Late does not mean Half Day immediately. Wait for Punch Out.
            name: userName,
            email: userEmail,
            shiftStart: shiftStart // Store shift for record
        });

        return { success: true, message: "Punched in successfully." };
    } catch (error: any) {
        console.error("Punch In Error:", error);
        return { success: false, error: error.message };
    }
}

export async function punchOut(idToken: string, lat: number, lng: number, forceHalfDay: boolean = false) {
    try {
        // 1. Verify Token
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // 2. Validate Location
        if (!OFFICE_LAT || !OFFICE_LNG) {
            throw new Error("Office location not configured.");
        }
        const distance = getDistanceFromLatLonInMeters(lat, lng, OFFICE_LAT, OFFICE_LNG);
        if (distance > MAX_DISTANCE_METERS) {
            throw new Error(`You are ${Math.round(distance)}m away from office.`);
        }

        // 3. Get Record
        const now = new Date();
        const zonedNow = toZonedTime(now, TIME_ZONE);
        const todayStr = format(zonedNow, "yyyy-MM-dd");

        const recordRef = adminDb.collection("attendance").doc(`${uid}_${todayStr}`);
        const recordSnap = await recordRef.get();

        if (!recordSnap.exists) {
            throw new Error("No punch-in record found for today.");
        }

        const data = recordSnap.data();
        if (data?.punchOut) {
            throw new Error("Already punched out today.");
        }

        // 4. Validate Time vs Required
        const requiredOut = data?.requiredPunchOut.toDate(); // This is correctly UTC

        let status = "Present";

        // Check if now (UTC) is before requiredOut (UTC)
        if (now < requiredOut) {
            if (forceHalfDay) {
                status = "Half Day";
            } else {
                // If not forced and early, strictly speaking we should block or mark absent.
                // The UI should handle the confirmation. If we are here, we allow it.
                // But logic says: if early and NOT forced -> Absent. 
                // However, user wants "Force Punch Out" option. 
                // If they just click Punch Out early without force, it's Absent? 
                // Or maybe we treat simple early punch out as Absent, and specific action as Half Day.
                status = "Absent";
            }
        }

        // Calculate Overtime
        // Logic: If they came ON TIME (Late == 0) and stayed AFTER Shift End.
        let overtimeMinutes = 0;
        let overtimeStatus = "none";

        if (data && now > requiredOut) {
            const diffMs = now.getTime() - requiredOut.getTime();
            overtimeMinutes = Math.floor(diffMs / 60000); // Minutes worked extra beyond required 9h
        }

        if (overtimeMinutes > 0) {
            overtimeStatus = "pending"; // Requires Admin Approval
        }

        await recordRef.update({
            punchOut: {
                time: Timestamp.fromDate(now),
                lat,
                lng
            },
            status: status,
            overtimeMinutes: overtimeMinutes,
            overtimeStatus: overtimeStatus
        });

        return { success: true, message: `Punched out. Status: ${status}` };

    } catch (error: any) {
        console.error("Punch Out Error:", error);
        return { success: false, error: error.message };
    }
}

// Admin Action: Update Attendance Record
export async function updateAttendanceRecord(idToken: string, recordId: string, newPunchInTimeStr?: string, newPunchOutTimeStr?: string) {
    try {
        // 1. Verify Admin
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const adminUid = decodedToken.uid;
        const userDoc = await adminDb.collection("users").doc(adminUid).get();
        if (userDoc.data()?.role !== "admin") {
            throw new Error("Unauthorized");
        }

        const recordRef = adminDb.collection("attendance").doc(recordId);
        const recordSnap = await recordRef.get();
        if (!recordSnap.exists) throw new Error("Record not found");

        const data = recordSnap.data();
        if (!data) throw new Error("No data");

        const dateStr = data.date; // YYYY-MM-DD

        // 2. Calculate new Times if provided
        // Input format is "HH:mm" (24h) assumed to be in IST

        let updates: any = {};
        let newPunchInDateUTC = data.punchIn.time.toDate();

        if (newPunchInTimeStr) {
            const [hours, minutes] = newPunchInTimeStr.split(":").map(Number);
            const dateTimeStr = `${dateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
            newPunchInDateUTC = fromZonedTime(dateTimeStr, TIME_ZONE);

            updates["punchIn.time"] = Timestamp.fromDate(newPunchInDateUTC);
        }

        // Fetch Shift Start from Record (if saved) or fallback to User Profile
        // Note: 'data' is the attendance record. We added 'shiftStart' to records in punchIn recently.
        // If old record, fetch user profile again.

        let shiftStart = data.shiftStart;
        if (!shiftStart) {
            const employeeDoc = await adminDb.collection("users").doc(data.uid).get();
            shiftStart = employeeDoc.data()?.shift || "10:00";
        }

        console.log(`Debug Update: User=${data.name}, Shift=${shiftStart}`); // Log to terminal

        // Determine Shift Config
        let startHour = 10;
        let startMin = 0;
        if (shiftStart.includes(":")) {
            const parts = shiftStart.split(":");
            startHour = parseInt(parts[0]);
            startMin = parseInt(parts[1]);
        }

        const isRegularShift = (startHour === 10 && startMin === 0);
        const currentGracePeriod = isRegularShift ? 10 : 0;

        // Re-calcaulte duration locally for update
        let shiftDurationHours = 9;
        if (startHour === 13) shiftDurationHours = 6.5;

        // Recalculate Late and Required Out based on (new or old) Punch In
        const officeStartStr = `${dateStr} ${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00`;
        const officeStartUTC = fromZonedTime(officeStartStr, TIME_ZONE);
        const graceEndUTC = new Date(officeStartUTC.getTime() + currentGracePeriod * 60000);

        let lateMinutes = 0;
        if (newPunchInDateUTC > graceEndUTC) {
            const diffMs = newPunchInDateUTC.getTime() - officeStartUTC.getTime();
            lateMinutes = Math.floor(diffMs / 60000);
        }
        // Status stays same if editing In Time, unless manually changed elsewhere?
        // Actually, status depends on PunchOut. If only editing PunchIn, we might not know PunchOut yet.
        // If we have punchOut, we recalc status below.
        // If Late, we DO NOT mark Half Day immediately now.
        // if (lateMinutes > 0) updates.status = "Half Day"; // REMOVED per valid 9h logic
        updates.lateMinutes = lateMinutes;

        const requiredPunchOutUTC = new Date(newPunchInDateUTC.getTime() + (shiftDurationHours * 60 * 60 * 1000));

        updates.requiredPunchOut = Timestamp.fromDate(requiredPunchOutUTC);

        // Handle Punch Out Update
        let newPunchOutDateUTC = data.punchOut ? data.punchOut.time.toDate() : null;

        if (newPunchOutTimeStr) {
            const [hours, minutes] = newPunchOutTimeStr.split(":").map(Number);
            const dateTimeStr = `${dateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
            newPunchOutDateUTC = fromZonedTime(dateTimeStr, TIME_ZONE);

            updates["punchOut"] = {
                ...data.punchOut,
                time: Timestamp.fromDate(newPunchOutDateUTC),
                lat: data.punchOut?.lat || 0, // Preserve location or default
                lng: data.punchOut?.lng || 0
            };
        }

        // Recalculate Status if Punch Out exists (either old or new)
        if (newPunchOutDateUTC) {
            let status = "Present";

            // If punched out before required time
            if (newPunchOutDateUTC < requiredPunchOutUTC) {
                // Determine if it was significantly early?
                // User logic: "agr time se pehle punchout ... force punchout to mark as half day".
                // Admin editing implies setting correct status manually? 
                // We'll trust if Admin sets time < 9h, it might be Half Day or Absent.
                // But generally, Admin sets time to FIX things.
                // Leaving as "Present" if close? Or strict?
                // Defaulting to "Present" but let's see OT.
                // Actually, if strictly < 9h, should be Half Day?
                // Let's rely on Work Duration.
                const workedMs = newPunchOutDateUTC.getTime() - newPunchInDateUTC.getTime();
                const workedMinutes = workedMs / 60000;
                if (workedMinutes < (shiftDurationHours * 60)) {
                    status = "Half Day"; // Or Absent? "Half Day" seems safer for "Not Full Day"
                }
            }

            updates.status = status;

            // Recalculate Overtime for Admin Actions
            let overtimeMinutes = 0;
            if (newPunchOutDateUTC > requiredPunchOutUTC) {
                const diffMs = newPunchOutDateUTC.getTime() - requiredPunchOutUTC.getTime();
                overtimeMinutes = Math.floor(diffMs / 60000);
            }
            updates.overtimeMinutes = overtimeMinutes;
            if (overtimeMinutes > 0) {
                updates.overtimeStatus = "approved"; // Admin sets it -> Approved
            } else {
                updates.overtimeStatus = "none";
            }
        } else {
            // If we removed punch out (not implemented here) or still open
            updates.status = "Working";
        }

        await recordRef.update(updates);

        return { success: true, message: "Record updated successfully" };

    } catch (error: any) {
        console.error("Update Error:", error);
        return { success: false, error: error.message };
    }
}

export async function deleteAttendanceRecord(idToken: string, recordId: string) {
    try {
        // 1. Verify Admin
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const adminUid = decodedToken.uid;
        const userDoc = await adminDb.collection("users").doc(adminUid).get();
        if (userDoc.data()?.role !== "admin") {
            throw new Error("Unauthorized");
        }

        // 2. Delete Record
        await adminDb.collection("attendance").doc(recordId).delete();

        return { success: true, message: "Record deleted successfully" };
    } catch (error: any) {
        console.error("Delete Error:", error);
        return { success: false, error: error.message };
    }
}

export async function approveOvertime(idToken: string, recordId: string, status: "approved" | "rejected") {
    try {
        // 1. Verify Admin
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const adminUid = decodedToken.uid;
        const userDoc = await adminDb.collection("users").doc(adminUid).get();
        if (userDoc.data()?.role !== "admin") {
            throw new Error("Unauthorized");
        }

        // 2. Update Record
        await adminDb.collection("attendance").doc(recordId).update({
            overtimeStatus: status
        });

        return { success: true, message: `Overtime ${status}` };
    } catch (error: any) {
        console.error("Overtime Approval Error:", error);
        return { success: false, error: error.message };
    }
}

// Holiday Management
export async function addHoliday(idToken: string, date: string, name: string, type: "holiday" | "working" = "holiday") {
    try {
        // 1. Verify Admin
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const userDoc = await adminDb.collection("users").doc(decodedToken.uid).get();
        if (userDoc.data()?.role !== "admin") throw new Error("Unauthorized");

        // 2. Add/Update Holiday
        await adminDb.collection("holidays").doc(date).set({
            date,
            name,
            type
        });

        return { success: true, message: "Holiday added/updated" };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

export async function deleteHoliday(idToken: string, dateId: string) {
    try {
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const userDoc = await adminDb.collection("users").doc(decodedToken.uid).get();
        if (userDoc.data()?.role !== "admin") throw new Error("Unauthorized");

        await adminDb.collection("holidays").doc(dateId).delete();
        return { success: true, message: "Holiday deleted" };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}
