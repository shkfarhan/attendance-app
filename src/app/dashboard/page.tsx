"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, onSnapshot, getDoc, collection, query, where, orderBy, limit } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { getDistanceFromLatLonInMeters, formatDuration } from "@/lib/utils";
import { punchIn, punchOut } from "../actions";
import { generateMonthlyReport } from "../report-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Loader2, MapPin, Clock, LogOut, CheckCircle, XCircle, AlertTriangle, Download, Calendar } from "lucide-react";
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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export default function Dashboard() {
    const [user, setUser] = useState<User | null>(null);
    const [userName, setUserName] = useState<string>("");
    const [loading, setLoading] = useState(true);
    const [attendance, setAttendance] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [locationLoading, setLocationLoading] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [message, setMessage] = useState("");
    const [now, setNow] = useState(new Date());

    // Report State
    const [reportOpen, setReportOpen] = useState(false);
    const [reportMonth, setReportMonth] = useState<string>(String(new Date().getMonth()));
    const [reportYear, setReportYear] = useState<string>(String(new Date().getFullYear()));

    const router = useRouter();

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (!currentUser) {
                router.push("/");
            } else {
                setUser(currentUser);

                if (currentUser.displayName) {
                    setUserName(currentUser.displayName);
                } else {
                    const userDoc = await getDoc(doc(db, "users", currentUser.uid));
                    if (userDoc.exists() && userDoc.data().name) {
                        setUserName(userDoc.data().name);
                    } else {
                        setUserName("Employee");
                    }
                }

                const now = new Date();
                const offset = 5.5 * 60 * 60 * 1000;
                const istDate = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + offset);
                const dateStr = istDate.toISOString().split("T")[0];

                const docRef = doc(db, "attendance", `${currentUser.uid}_${dateStr}`);
                onSnapshot(docRef, (doc) => {
                    if (doc.exists()) {
                        setAttendance(doc.data());
                    } else {
                        setAttendance(null);
                    }
                });

                // Fetch History (No OrderBy to avoid Index requirements if not present)
                const q = query(
                    collection(db, "attendance"),
                    where("uid", "==", currentUser.uid)
                );

                onSnapshot(q, (snap) => {
                    const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
                    // Client-side sort
                    docs.sort((a: any, b: any) => {
                        const dateA = a.date || "";
                        const dateB = b.date || "";
                        return dateB.localeCompare(dateA);
                    });
                    setHistory(docs.slice(0, 30));
                }, (err) => {
                    console.error("History fetch error:", err);
                });
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, [router]);

    const getDurationString = (start: Date, end: Date) => {
        const diff = end.getTime() - start.getTime();
        if (diff < 0) return "00h 00m 00s";
        const hrs = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    };

    const getLocation = (): Promise<GeolocationPosition> => {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error("Geolocation not supported"));
                return;
            }
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            });
        });
    };

    const handlePunch = async (type: "in" | "out", forceHalfDay: boolean = false) => {
        if (!user) return;
        setLocationLoading(true);
        setMessage("");

        try {
            const position = await getLocation();
            const { latitude, longitude } = position.coords;
            const token = await user.getIdToken();

            setActionLoading(true);

            let result;
            if (type === "in") {
                result = await punchIn(token, latitude, longitude);
            } else {
                result = await punchOut(token, latitude, longitude, forceHalfDay);
            }

            if (result.success) {
                setMessage(result.message || "Success");
            } else {
                setMessage(result.error || "Action failed");
            }

        } catch (err: any) {
            console.error("HandlePunch Error:", err);
            let msg = "Location error. Ensure GPS is on.";
            if (err instanceof Error) {
                msg = err.message;
            } else if (typeof err === "object" && err !== null) {
                if ('message' in err) msg = (err as any).message;
                else if ('code' in err) {
                    switch ((err as any).code) {
                        case 1: msg = "Permission Denied. Please allow location access."; break;
                        case 2: msg = "Position Unavailable. Check GPS."; break;
                        case 3: msg = "Timeout acquiring location."; break;
                    }
                }
            }
            setMessage(msg);
        } finally {
            setLocationLoading(false);
            setActionLoading(false);
        }
    };

    const handleDownload = async () => {
        if (!user) return;
        setDownloading(true);
        try {
            const m = parseInt(reportMonth);
            const y = parseInt(reportYear);

            const exportRes = await generateMonthlyReport(y, m, user.uid);

            if (exportRes.success && exportRes.data) {
                const byteCharacters = atob(exportRes.data);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                const link = document.createElement('a');
                link.href = window.URL.createObjectURL(blob);
                link.download = exportRes.filename || "Report.xlsx";
                link.click();
                setReportOpen(false);
            } else {
                alert("Download failed: " + exportRes.error);
            }
        } catch (e: any) {
            alert("Error: " + e.message);
        } finally {
            setDownloading(false);
        }
    };

    if (loading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin" /></div>;

    const isPunchOutRestricted = attendance?.status === "Working" && attendance?.requiredPunchOut && now < attendance.requiredPunchOut.toDate();

    return (
        <div className="min-h-screen bg-gray-100 p-4 pb-20">
            <div className="max-w-md mx-auto space-y-6">
                <header className="flex justify-between items-center bg-white p-4 rounded-lg shadow-sm">
                    <div>
                        <h1 className="text-xl font-bold">Attendance</h1>
                        <p className="text-sm text-gray-500">{format(new Date(), "EEEE, d MMM")}</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => auth.signOut()}>
                        <LogOut className="h-5 w-5" />
                    </Button>
                </header>

                <Card>
                    <CardHeader>
                        <CardTitle>Hello, {userName}</CardTitle>
                        <CardDescription>
                            {attendance ? "You are dealing with today's tasks." : "Please mark your attendance."}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">

                        <div className="flex flex-col items-center justify-center p-6 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                            {attendance ? (
                                attendance.status === "Working" ? (
                                    <div className="text-center space-y-4 w-full">
                                        <div className="bg-white p-4 rounded-lg shadow-sm border">
                                            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Working Duration</p>
                                            <p className="text-3xl font-mono font-bold text-blue-600 tabular-nums">
                                                {attendance.punchIn ? getDurationString(attendance.punchIn.time.toDate(), now) : "00:00:00"}
                                            </p>
                                        </div>

                                        <div className="grid grid-cols-2 gap-2 text-sm">
                                            <div className="bg-blue-50 p-2 rounded border border-blue-100">
                                                <p className="text-xs text-blue-600 font-medium">Remaining</p>
                                                <p className="font-mono font-bold text-blue-800 tabular-nums">
                                                    {attendance.requiredPunchOut ? getDurationString(now, attendance.requiredPunchOut.toDate()) : "--"}
                                                </p>
                                            </div>
                                            <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                                <p className="text-xs text-gray-500 font-medium">Punch Out At</p>
                                                <p className="font-bold text-gray-700">
                                                    {attendance.requiredPunchOut ? format(attendance.requiredPunchOut.toDate(), "hh:mm a") : "--"}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="text-center space-y-2">
                                        {attendance.status === "Present" ?
                                            <CheckCircle className="h-10 w-10 text-green-500 mx-auto" /> :
                                            <XCircle className="h-10 w-10 text-red-500 mx-auto" />
                                        }
                                        <h3 className="text-lg font-semibold">{attendance.status}</h3>
                                    </div>
                                )
                            ) : (
                                <div className="text-center text-gray-400">
                                    <MapPin className="h-10 w-10 mx-auto mb-2" />
                                    <p>Not Punched In</p>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <Button
                                className="h-24 text-lg flex flex-col gap-2"
                                disabled={!!attendance || locationLoading || actionLoading}
                                onClick={() => handlePunch("in")}
                                variant="default"
                            >
                                <span className="font-bold">PUNCH IN</span>
                                {attendance?.punchIn && <span className="text-xs font-normal opacity-80">at {format(attendance.punchIn.time.toDate(), "hh:mm a")}</span>}
                            </Button>

                            <div className="flex flex-col gap-2">
                                {isPunchOutRestricted ? (
                                    <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                            <Button
                                                className="h-24 text-lg flex flex-col gap-2 w-full"
                                                variant="destructive"
                                            >
                                                <span className="font-bold">FORCE OUT</span>
                                                <span className="text-xs font-normal opacity-80">Early Exit</span>
                                            </Button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                            <AlertDialogHeader>
                                                <AlertDialogTitle>Leave Early?</AlertDialogTitle>
                                                <AlertDialogDescription>
                                                    You are leaving before the required time. This will be marked as a <strong>Half Day</strong>.
                                                </AlertDialogDescription>
                                            </AlertDialogHeader>
                                            <AlertDialogFooter>
                                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                <AlertDialogAction onClick={() => handlePunch("out", true)} className="bg-red-600 hover:bg-red-700">
                                                    Yes, Mark Half Day
                                                </AlertDialogAction>
                                            </AlertDialogFooter>
                                        </AlertDialogContent>
                                    </AlertDialog>
                                ) : (
                                    <Button
                                        className="h-24 text-lg flex flex-col gap-2 w-full"
                                        disabled={!attendance || !!attendance.punchOut || locationLoading || actionLoading}
                                        onClick={() => handlePunch("out")}
                                        variant={attendance?.punchOut ? "secondary" : "destructive"}
                                    >
                                        <span className="font-bold">PUNCH OUT</span>
                                        {attendance?.punchOut && <span className="text-xs font-normal opacity-80">at {format(attendance.punchOut.time.toDate(), "hh:mm a")}</span>}
                                    </Button>
                                )}

                                {isPunchOutRestricted && (
                                    <p className="text-center text-xs text-amber-600 font-medium flex items-center justify-center gap-1">
                                        <AlertTriangle className="h-3 w-3" /> Early exit marks Half Day
                                    </p>
                                )}
                            </div>
                        </div>

                        {locationLoading && <p className="text-center text-xs text-muted-foreground animate-pulse">Acquiring verified location...</p>}
                        {message && <p className={`text-center text-sm font-medium ${message.includes("Success") ? "text-green-600" : "text-red-500"}`}>{message}</p>}

                    </CardContent>
                </Card>

                {attendance && (
                    <Card>
                        <CardHeader><CardTitle className="text-base">Today's Details</CardTitle></CardHeader>
                        <CardContent className="text-sm space-y-2">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Late Minutes:</span>
                                <span className="font-medium">{formatDuration(attendance.lateMinutes)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Required Out:</span>
                                <span className="font-medium">{attendance.requiredPunchOut ? format(attendance.requiredPunchOut.toDate(), "hh:mm a") : "-"}</span>
                            </div>
                        </CardContent>
                    </Card>
                )}

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Calendar className="h-4 w-4" />
                            Recent History
                        </CardTitle>

                        <Dialog open={reportOpen} onOpenChange={setReportOpen}>
                            <DialogTrigger asChild>
                                <Button variant="outline" size="sm">
                                    <Download className="h-3 w-3 mr-1" />
                                    <span className="sr-only sm:not-sr-only sm:inline">Report</span>
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
                                        <Label htmlFor="month" className="text-right">
                                            Month
                                        </Label>
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
                                        <Label htmlFor="year" className="text-right">
                                            Year
                                        </Label>
                                        <Input
                                            id="year"
                                            value={reportYear}
                                            onChange={(e) => setReportYear(e.target.value)}
                                            className="col-span-3 w-[180px]"
                                            type="number"
                                        />
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button type="button" onClick={handleDownload} disabled={downloading}>
                                        {downloading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        Download
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {history.length === 0 ? (
                            <p className="text-sm text-gray-500 text-center py-4">No recent records.</p>
                        ) : (
                            history.map((record) => (
                                <div key={record.id} className="flex justify-between items-center py-2 border-b last:border-0">
                                    <div>
                                        <p className="font-semibold text-sm">{format(new Date(record.date), "MMM d")}</p>
                                        <p className="text-xs text-muted-foreground">{format(new Date(record.date), "EEE")}</p>
                                    </div>
                                    <div className="text-right text-sm">
                                        <div className="flex items-center justify-end gap-2">
                                            <span className={`font-mono text-xs ${record.lateMinutes > 0 ? "text-red-500 font-bold" : "text-gray-600"}`}>
                                                {record.punchIn ? format(record.punchIn.time.toDate(), "hh:mm a") : "-"}
                                            </span>
                                            <span className="text-gray-400">→</span>
                                            <span className="font-mono text-xs text-gray-600">
                                                {record.punchOut ? format(record.punchOut.time.toDate(), "hh:mm a") : "-"}
                                            </span>
                                        </div>
                                        <div className="flex justify-end gap-1 mt-1">
                                            <Badge variant="outline" className={`text-[10px] px-1 py-0 ${record.status === "Present" ? "bg-green-50 text-green-700 border-green-200" :
                                                record.status === "Absent" ? "bg-red-50 text-red-700 border-red-200" :
                                                    "bg-blue-50 text-blue-700 border-blue-200"
                                                }`}>
                                                {record.status}
                                            </Badge>
                                            {record.overtimeMinutes > 0 && (
                                                <Badge variant="outline" className="text-[10px] px-1 py-0 bg-purple-50 text-purple-700 border-purple-200">
                                                    OT: {formatDuration(record.overtimeMinutes)}
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
