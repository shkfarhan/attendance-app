"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { collection, query, where, getDocs, doc, getDoc, orderBy, onSnapshot } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { updateAttendanceRecord, deleteAttendanceRecord, approveOvertime, addHoliday, deleteHoliday } from "../actions";
import { generateMonthlyReport } from "../report-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter
} from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { formatDuration } from "@/lib/utils";
import { Loader2, Download, LogOut, Edit2, X, Save, Trash2, CheckCircle, XCircle, CalendarDays, Plus } from "lucide-react";



export default function AdminDashboard() {
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<any[]>([]);
    const [userMap, setUserMap] = useState<Record<string, string>>({});
    const [dateFilter, setDateFilter] = useState(new Date().toISOString().split("T")[0]);
    const router = useRouter();

    // Edit State
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editIn, setEditIn] = useState("");
    const [editOut, setEditOut] = useState("");
    const [saving, setSaving] = useState(false);

    // Report State
    const [reportOpen, setReportOpen] = useState(false);
    const [reportMonth, setReportMonth] = useState<string>(String(new Date().getMonth()));
    const [reportYear, setReportYear] = useState<string>(String(new Date().getFullYear())); // Corrected: Use standard YYYY

    // Holidays State
    const [holidays, setHolidays] = useState<any[]>([]);
    const [holidayOpen, setHolidayOpen] = useState(false);
    const [newHolidayDate, setNewHolidayDate] = useState("");
    const [newHolidayName, setNewHolidayName] = useState("");
    const [newHolidayType, setNewHolidayType] = useState<"holiday" | "working">("holiday");

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                router.push("/");
                return;
            }
            const userRef = doc(db, "users", user.uid);
            const userSnap = await getDoc(userRef);
            if (!userSnap.exists() || userSnap.data().role !== "admin") {
                router.push("/dashboard");
                return;
            }

            try {
                const usersSnap = await getDocs(collection(db, "users"));
                const map: Record<string, string> = {};
                usersSnap.forEach(doc => {
                    const d = doc.data();
                    if (d.name) map[doc.id] = d.name;
                });
                setUserMap(map);
            } catch (err) {
                console.error("Error fetching users map:", err);
            }

            setLoading(false);
        });
        return () => unsub();
    }, [router]);

    useEffect(() => {
        if (loading) return;

        // Attendance Listener
        const q = query(
            collection(db, "attendance"),
            where("date", "==", dateFilter)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const results = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
            results.sort((a: any, b: any) => (a.punchIn?.time?.seconds || 0) - (b.punchIn?.time?.seconds || 0));
            setData(results);
        }, (error) => {
            console.error("Real-time fetch error:", error);
        });

        // Holidays Listener
        const unsubHolidays = onSnapshot(query(collection(db, "holidays"), orderBy("date", "desc")), (snap) => {
            setHolidays(snap.docs.map(d => d.data()));
        });

        return () => {
            unsubscribe();
            unsubHolidays();
        };
    }, [dateFilter, loading]);

    const startEdit = (record: any) => {
        setEditingId(record.id);
        const inTime = record.punchIn ? format(record.punchIn.time.toDate(), "HH:mm") : "";
        const outTime = record.punchOut ? format(record.punchOut.time.toDate(), "HH:mm") : "";
        setEditIn(inTime);
        setEditOut(outTime);
    };

    const cancelEdit = () => {
        setEditingId(null);
        setEditIn("");
        setEditOut("");
    };

    const saveEdit = async () => {
        if (!editingId) return;
        setSaving(true);
        try {
            const user = auth.currentUser;
            if (!user) return;
            const token = await user.getIdToken();

            const result = await updateAttendanceRecord(token, editingId, editIn, editOut);
            if (result.success) {
                setEditingId(null);
            } else {
                alert("Update failed: " + result.error);
            }
        } catch (err: any) {
            alert("Error: " + err.message);
        } finally {
            setSaving(false);
        }
    };

    const downloadReport = async () => {
        setSaving(true);
        try {
            const m = parseInt(reportMonth);
            const y = parseInt(reportYear); // 21st prev to 20th cur logic uses this
            // We need to ensure users understand the logic.
            // But code asks for Year.
            // If month is Jan (0), prev month is Dec last year. Logic handles it.

            // Adjust logic: If generating for Jan 2026, user selects Jan 2026.
            // Report logic: 21 Dec 2025 -> 20 Jan 2026. Correct.

            // generateMonthlyReport uses 1-based month?
            // Wait. In report-action.ts, Step 761:
            // const targetMonth = month !== undefined ? month : now.getMonth();
            // BUT native getMonth() is 0-indexed.
            // If I pass 0 from Select (value="0"), targetMonth=0.
            // startDate = new Date(year, 0-1, 21) => Dec 21 prev year.
            // endDate = new Date(year, 0, 20) => Jan 20 curr year.
            // This is CORRECT for "January Salary Report".
            // So we should pass 0 for Jan.
            // HOWEVER, Step 761 `const targetMonth = month !== undefined ? month : ...`
            // If I passed `m + 1` in my previous logic (for single download), I might be mixing 0/1 base.
            // Let's check `report-action.ts` again.
            // It relies on JS Date constructor which uses 0-indexed month.
            // So passing 0 for Jan is correct.
            // I will pass `m` directly.

            const result = await generateMonthlyReport(y, m);
            if (result.success && result.data) {
                const byteCharacters = atob(result.data);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                const link = document.createElement('a');
                link.href = window.URL.createObjectURL(blob);
                link.download = result.filename || "Report.xlsx";
                link.click();
                setReportOpen(false);
            } else {
                alert("Failed: " + result.error);
            }
        } catch (e: any) {
            alert("Error generating report: " + e.message);
        } finally {
            setSaving(false);
        }
    };

    const handleOvertime = async (recordId: string, status: "approved" | "rejected") => {
        setSaving(true);
        try {
            const user = auth.currentUser;
            if (!user) return;
            const token = await user.getIdToken();
            const result = await approveOvertime(token, recordId, status);
            if (!result.success) {
                alert("Action failed: " + result.error);
            }
        } catch (e: any) {
            alert("Error: " + e.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (recordId: string) => {
        setSaving(true);
        try {
            const user = auth.currentUser;
            if (!user) return;
            const token = await user.getIdToken();
            const result = await deleteAttendanceRecord(token, recordId);
            if (!result.success) {
                alert("Delete failed: " + result.error);
            }
        } catch (err: any) {
            alert("Error: " + err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleAddHoliday = async () => {
        if (!newHolidayDate || !newHolidayName) return;
        setSaving(true);
        try {
            const user = auth.currentUser;
            if (!user) return;
            const token = await user.getIdToken();
            const result = await addHoliday(token, newHolidayDate, newHolidayName, newHolidayType);
            if (result.success) {
                setNewHolidayName("");
                setNewHolidayDate("");
                // Dialog stays open to add more?
            } else {
                alert("Failed: " + result.error);
            }
        } catch (e: any) {
            alert("Error: " + e.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteHoliday = async (dateId: string) => {
        if (!confirm("Delete this holiday?")) return;
        try {
            const user = auth.currentUser;
            if (!user) return;
            const token = await user.getIdToken();
            await deleteHoliday(token, dateId);
        } catch (e: any) { alert(e.message); }
    };

    const exportCSV = () => {
        if (!data.length) return;

        // Headers
        const headers = ["Employee Name", "Email", "Date", "Punch In", "Punch Out", "Late (min)", "Overtime (min)", "Status"];
        const rows = data.map(row => {
            const dbName = userMap[row.uid];
            const recordName = row.name || "";
            const isEmailName = recordName.includes("@");
            const finalName = dbName || (!isEmailName ? recordName : "Unknown");
            const finalEmail = row.email || (isEmailName ? recordName : "-");

            return [
                finalName,
                finalEmail,
                row.date,
                row.punchIn ? format(row.punchIn.time.toDate(), "hh:mm a") : "-",
                row.punchOut ? format(row.punchOut.time.toDate(), "hh:mm a") : "-",
                row.lateMinutes || 0,
                row.overtimeMinutes || 0,
                row.status
            ];
        });

        const csvContent = "data:text/csv;charset=utf-8,"
            + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `attendance_${dateFilter}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    if (loading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin" /></div>;

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="max-w-6xl mx-auto space-y-6">
                <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
                        <p className="text-muted-foreground">Monitor employee attendance</p>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                        <Button variant="outline" className="w-full sm:w-auto" onClick={() => router.push("/")}><LogOut className="mr-2 h-4 w-4" /> Logout</Button>
                    </div>
                </header>

                <Card>
                    <CardHeader className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <CardTitle>Attendance Records</CardTitle>
                        <div className="flex flex-wrap gap-2 items-start sm:items-center w-full md:w-auto">
                            <Input
                                type="date"
                                value={dateFilter}
                                onChange={(e) => setDateFilter(e.target.value)}
                                className="w-[150px]"
                            />

                            {/* Holidays Button */}
                            <Dialog open={holidayOpen} onOpenChange={setHolidayOpen}>
                                <DialogTrigger asChild>
                                    <Button variant="outline">
                                        <CalendarDays className="mr-2 h-4 w-4" /> Holidays
                                    </Button>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
                                    <DialogHeader>
                                        <DialogTitle>Manage Holidays</DialogTitle>
                                        <DialogDescription>
                                            Add holidays or mark specific days (like Saturdays) as working.
                                        </DialogDescription>
                                    </DialogHeader>

                                    <div className="flex gap-2 items-end py-4 border-b">
                                        <div className="grid gap-1.5 flex-1">
                                            <Label>Date</Label>
                                            <Input type="date" value={newHolidayDate} onChange={e => setNewHolidayDate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5 flex-[2]">
                                            <Label>Description</Label>
                                            <Input placeholder="e.g. Diwali / Working Sat" value={newHolidayName} onChange={e => setNewHolidayName(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5 flex-1">
                                            <Label>Type</Label>
                                            <Select value={newHolidayType} onValueChange={(v: any) => setNewHolidayType(v)}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="holiday">Holiday</SelectItem>
                                                    <SelectItem value="working">Working</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <Button onClick={handleAddHoliday} disabled={saving}><Plus className="h-4 w-4" /></Button>
                                    </div>

                                    <div className="flex-1 -mx-6 px-6 overflow-y-auto max-h-[300px]">
                                        <div className="space-y-2 py-4">
                                            {holidays.length === 0 ? <p className="text-center text-gray-500 text-sm">No holidays configured.</p> : holidays.map((h, i) => (
                                                <div key={h.date} className="flex justify-between items-center bg-gray-50 p-2 rounded">
                                                    <div>
                                                        <span className="font-mono text-sm mr-2">{h.date}</span>
                                                        <span className={`text-sm font-medium ${h.type === "working" ? "text-blue-600" : "text-green-600"}`}>{h.name}</span>
                                                        <span className="text-xs text-gray-400 ml-2">({h.type})</span>
                                                    </div>
                                                    <Button variant="ghost" size="sm" onClick={() => handleDeleteHoliday(h.date)}><Trash2 className="h-3 w-3 text-red-500" /></Button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </DialogContent>
                            </Dialog>

                            <Button onClick={exportCSV} variant="secondary">
                                <Download className="mr-2 h-4 w-4" /> Daily CSV
                            </Button>

                            <Dialog open={reportOpen} onOpenChange={setReportOpen}>
                                <DialogTrigger asChild>
                                    <Button variant="default">
                                        <Download className="mr-2 h-4 w-4" /> Monthly Excel
                                    </Button>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-[425px]">
                                    <DialogHeader>
                                        <DialogTitle>Download Monthly Report</DialogTitle>
                                        <DialogDescription>
                                            Select the Salary Month. Report covers 21st of previous month to 20th of selected month.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <div className="grid gap-4 py-4">
                                        <div className="grid grid-cols-4 items-center gap-4">
                                            <Label htmlFor="month" className="text-right">Month</Label>
                                            <Select value={reportMonth} onValueChange={setReportMonth}>
                                                <SelectTrigger className="w-[180px] col-span-3">
                                                    <SelectValue placeholder="Select Month" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="0">January</SelectItem>
                                                    <SelectItem value="1">February</SelectItem>
                                                    <SelectItem value="2">March</SelectItem>
                                                    <SelectItem value="3">April</SelectItem>
                                                    <SelectItem value="4">May</SelectItem>
                                                    <SelectItem value="5">June</SelectItem>
                                                    <SelectItem value="6">July</SelectItem>
                                                    <SelectItem value="7">August</SelectItem>
                                                    <SelectItem value="8">September</SelectItem>
                                                    <SelectItem value="9">October</SelectItem>
                                                    <SelectItem value="10">November</SelectItem>
                                                    <SelectItem value="11">December</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="grid grid-cols-4 items-center gap-4">
                                            <Label htmlFor="year" className="text-right">Year</Label>
                                            <Input id="year" value={reportYear} onChange={(e) => setReportYear(e.target.value)} className="col-span-3 w-[180px]" type="number" />
                                        </div>
                                    </div>
                                    <DialogFooter>
                                        <Button type="button" onClick={downloadReport} disabled={saving}>
                                            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                            Download
                                        </Button>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto hidden md:block">
                            <table className="w-full text-sm text-left">
                                <thead className="text-xs text-gray-700 uppercase bg-gray-100">
                                    <tr>
                                        <th className="px-6 py-3">Employee</th>
                                        <th className="px-6 py-3">Email</th>
                                        <th className="px-6 py-3">Punch In</th>
                                        <th className="px-6 py-3">Punch Out</th>
                                        <th className="px-6 py-3">Late (min)</th>
                                        <th className="px-6 py-3">Overtime</th>
                                        <th className="px-6 py-3">Status</th>
                                        <th className="px-6 py-3">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.length === 0 ? (
                                        <tr><td colSpan={8} className="px-6 py-4 text-center">No records found for this date.</td></tr>
                                    ) : (
                                        data.map((record, i) => {
                                            const dbName = userMap[record.uid];
                                            const recordName = record.name || "";
                                            const isEmailName = recordName.includes("@");
                                            const displayName = dbName || (!isEmailName ? recordName : "Unknown");
                                            const displayEmail = record.email || (isEmailName ? recordName : "-");

                                            return (
                                                <tr key={i} className="bg-white border-b hover:bg-gray-50">
                                                    <td className="px-6 py-4 font-medium text-gray-900">{displayName}</td>
                                                    <td className="px-6 py-4 text-muted-foreground">{displayEmail}</td>
                                                    {editingId === record.id ? (
                                                        <>
                                                            <td className="px-6 py-4"><Input type="time" value={editIn} onChange={e => setEditIn(e.target.value)} className="w-32" /></td>
                                                            <td className="px-6 py-4"><Input type="time" value={editOut} onChange={e => setEditOut(e.target.value)} className="w-32" /></td>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <td className="px-6 py-4">{record.punchIn ? format(record.punchIn.time.toDate(), "hh:mm a") : "-"}</td>
                                                            <td className="px-6 py-4">{record.punchOut ? format(record.punchOut.time.toDate(), "hh:mm a") : "-"}</td>
                                                        </>
                                                    )}
                                                    <td className={`px-6 py-4 ${record.lateMinutes > 0 ? "text-red-600 font-bold" : ""}`}>{formatDuration(record.lateMinutes)}</td>
                                                    <td className="px-6 py-4">
                                                        {record.overtimeMinutes > 0 ? (
                                                            <div className="flex flex-col gap-1 items-start">
                                                                <span className="font-semibold text-gray-900">{formatDuration(record.overtimeMinutes)}</span>
                                                                {record.overtimeStatus === "pending" ? (
                                                                    <div className="flex gap-1">
                                                                        <Button size="icon" variant="ghost" className="h-6 w-6 text-green-600 hover:text-green-700 hover:bg-green-50" onClick={() => handleOvertime(record.id, "approved")} title="Approve"><CheckCircle className="h-4 w-4" /></Button>
                                                                        <Button size="icon" variant="ghost" className="h-6 w-6 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => handleOvertime(record.id, "rejected")} title="Reject"><XCircle className="h-4 w-4" /></Button>
                                                                    </div>
                                                                ) : (
                                                                    <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${record.overtimeStatus === "approved" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>{record.overtimeStatus}</span>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <span className="text-muted-foreground">-</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className={`px-2 py-1 rounded text-xs font-semibold ${record.status === "Present" ? "bg-green-100 text-green-800" : record.status === "Absent" ? "bg-red-100 text-red-800" : "bg-blue-100 text-blue-800"}`}>{record.status}</span>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        {editingId === record.id ? (
                                                            <div className="flex gap-2">
                                                                <Button size="sm" variant="default" onClick={saveEdit} disabled={saving}><Save className="h-4 w-4" /></Button>
                                                                <Button size="sm" variant="ghost" onClick={cancelEdit}><X className="h-4 w-4" /></Button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex gap-2">
                                                                <Button size="sm" variant="ghost" onClick={() => startEdit(record)}><Edit2 className="h-4 w-4 text-blue-500" /></Button>
                                                                <AlertDialog>
                                                                    <AlertDialogTrigger asChild>
                                                                        <Button size="sm" variant="ghost"><Trash2 className="h-4 w-4 text-red-500" /></Button>
                                                                    </AlertDialogTrigger>
                                                                    <AlertDialogContent>
                                                                        <AlertDialogHeader>
                                                                            <AlertDialogTitle>Delete Record</AlertDialogTitle>
                                                                            <AlertDialogDescription>Are you sure you want to delete the attendance record for <strong>{record.name}</strong> on {record.date}?<br />This action cannot be undone.</AlertDialogDescription>
                                                                        </AlertDialogHeader>
                                                                        <AlertDialogFooter>
                                                                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                                            <AlertDialogAction onClick={() => handleDelete(record.id)} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                                                                        </AlertDialogFooter>
                                                                    </AlertDialogContent>
                                                                </AlertDialog>
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {/* Mobile View */}
                        <div className="md:hidden space-y-4">
                            {data.length === 0 ? (
                                <p className="text-center text-gray-500">No records found for this date.</p>
                            ) : (
                                data.map((record, i) => {
                                    const dbName = userMap[record.uid];
                                    const recordName = record.name || "";
                                    const isEmailName = recordName.includes("@");
                                    const displayName = dbName || (!isEmailName ? recordName : "Unknown");
                                    const displayEmail = record.email || (isEmailName ? recordName : "-");

                                    return (
                                        <div key={i} className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-3">
                                            <div className="flex justify-between items-start">
                                                <div>
                                                    <h3 className="font-semibold text-gray-900">{displayName}</h3>
                                                    <p className="text-xs text-muted-foreground">{displayEmail}</p>
                                                </div>
                                                <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${record.status === "Present" ? "bg-green-100 text-green-700" : record.status === "Absent" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"}`}>{record.status}</span>
                                            </div>

                                            <div className="grid grid-cols-2 gap-4 text-sm bg-gray-50 p-3 rounded-md">
                                                <div>
                                                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">Punch In</span>
                                                    {editingId === record.id ? (<Input type="time" value={editIn} onChange={e => setEditIn(e.target.value)} className="h-8 text-sm" />) : (<div className="font-mono text-gray-700">{record.punchIn ? format(record.punchIn.time.toDate(), "hh:mm a") : "-"}</div>)}
                                                </div>
                                                <div>
                                                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">Punch Out</span>
                                                    {editingId === record.id ? (<Input type="time" value={editOut} onChange={e => setEditOut(e.target.value)} className="h-8 text-sm" />) : (<div className="font-mono text-gray-700">{record.punchOut ? format(record.punchOut.time.toDate(), "hh:mm a") : "-"}</div>)}
                                                </div>
                                                <div className="col-span-2 flex items-center justify-between border-t border-gray-200 pt-2 mt-1">
                                                    <span className="text-xs font-medium text-gray-500">LATE DURATION</span>
                                                    <span className={`font-mono font-medium ${record.lateMinutes > 0 ? "text-red-600" : "text-gray-900"}`}>{formatDuration(record.lateMinutes)}</span>
                                                </div>
                                                <div className="col-span-2 flex items-center justify-between border-t border-gray-200 pt-2 mt-1">
                                                    <span className="text-xs font-medium text-gray-500">OVERTIME</span>
                                                    {record.overtimeMinutes > 0 ? (
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono font-medium text-gray-900">{formatDuration(record.overtimeMinutes)}</span>
                                                            {record.overtimeStatus === "pending" ? (
                                                                <div className="flex gap-1">
                                                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-green-600 hover:text-green-700 hover:bg-green-50" onClick={() => handleOvertime(record.id, "approved")}><CheckCircle className="h-4 w-4" /></Button>
                                                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => handleOvertime(record.id, "rejected")}><XCircle className="h-4 w-4" /></Button>
                                                                </div>
                                                            ) : (
                                                                <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${record.overtimeStatus === "approved" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>{record.overtimeStatus}</span>
                                                            )}
                                                        </div>
                                                    ) : (<span className="text-muted-foreground text-xs">-</span>)}
                                                </div>
                                            </div>

                                            <div className="flex justify-end pt-2">
                                                {editingId === record.id ? (
                                                    <div className="grid grid-cols-2 gap-2 w-full">
                                                        <Button size="sm" variant="default" onClick={saveEdit} disabled={saving}><Save className="mr-2 h-3.5 w-3.5" /> Save</Button>
                                                        <Button size="sm" variant="secondary" onClick={cancelEdit}><X className="mr-2 h-3.5 w-3.5" /> Cancel</Button>
                                                    </div>
                                                ) : (
                                                    <div className="flex gap-2 w-full justify-end">
                                                        <Button size="sm" variant="ghost" className="h-8 px-2 text-blue-600 hover:text-blue-700 hover:bg-blue-50" onClick={() => startEdit(record)}><Edit2 className="mr-1.5 h-3.5 w-3.5" /> Edit</Button>
                                                        <AlertDialog>
                                                            <AlertDialogTrigger asChild>
                                                                <Button size="sm" variant="ghost" className="h-8 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete</Button>
                                                            </AlertDialogTrigger>
                                                            <AlertDialogContent>
                                                                <AlertDialogHeader>
                                                                    <AlertDialogTitle>Delete Record</AlertDialogTitle>
                                                                    <AlertDialogDescription>Are you sure you want to delete the attendance record for <strong>{record.name}</strong> on {record.date}?<br />This action cannot be undone.</AlertDialogDescription>
                                                                </AlertDialogHeader>
                                                                <AlertDialogFooter>
                                                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                                    <AlertDialogAction onClick={() => handleDelete(record.id)} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                                                                </AlertDialogFooter>
                                                            </AlertDialogContent>
                                                        </AlertDialog>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
