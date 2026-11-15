AttendEase feature patch
========================

Files to replace:
- server/src/routes/dashboard.ts
- server/src/routes/reports.ts
- web/src/pages/Dashboard.tsx

Features:
1. Dashboard shows up to 10 students whose overall attendance is below 75%, plus the total count.
2. Reports includes a new "Weekly class and student attendance summary" report. It groups attendance by week and class and includes classes conducted, records, present/absent/on-leave counts, and attendance percentage.
3. The weekly report is automatically listed in the existing report catalogue because it is registered in server/src/routes/reports.ts.

Important:
- Back up these three original files before replacing them.
- This patch has not been run against your local database or compiled with your local dependencies in this environment. Build and test locally before deploying.
- Existing low_attendance report remains unchanged.
- The dashboard threshold is currently 75%.
