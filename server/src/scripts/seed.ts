/**
 * Seed script: seven departments, classes, subjects, staff, students, teachers,
 * assignments, and 3 weeks of demo attendance (flagged is_demo = TRUE).
 *
 * Demo data is separated from production records: classes/students/staff carry is_demo,
 * and attendance_sessions.is_demo = TRUE, so reports can exclude it.
 */
import { q, one, closeDb } from '../db/index.js';
import { migrate, seedReferenceData } from '../db/migrate.js';
import { hashPassword } from '../lib/crypto.js';
import { todayISO } from '../lib/types.js';

const DEPARTMENTS: [string, string][] = [
  ['AIML', 'Artificial Intelligence and Machine Learning'],
  ['AIDS', 'Artificial Intelligence and Data Science'],
  ['CYBER', 'Cybersecurity'],
  ['ECE', 'Electronics and Communication Engineering'],
  ['CS', 'Computer Science'],
  ['MECH', 'Mechanical Engineering'],
  ['CIVIL', 'Civil Engineering'],
];

const SUBJECT_POOL: Record<string, [string, string][]> = {
  AIML: [
    ['AIML301', 'Machine Learning'],
    ['AIML302', 'Deep Learning'],
    ['AIML303', 'Natural Language Processing'],
  ],
  AIDS: [
    ['AIDS301', 'Data Engineering'],
    ['AIDS302', 'Big Data Analytics'],
    ['AIDS303', 'Statistical Modelling'],
  ],
  CYBER: [
    ['CYB301', 'Network Security'],
    ['CYB302', 'Cryptography'],
    ['CYB303', 'Ethical Hacking'],
  ],
  ECE: [
    ['ECE301', 'Digital Signal Processing'],
    ['ECE302', 'VLSI Design'],
    ['ECE303', 'Embedded Systems'],
  ],
  CS: [
    ['CS301', 'Operating Systems'],
    ['CS302', 'Database Management Systems'],
    ['CS303', 'Computer Networks'],
  ],
  MECH: [
    ['MECH301', 'Thermodynamics'],
    ['MECH302', 'Fluid Mechanics'],
    ['MECH303', 'Machine Design'],
  ],
  CIVIL: [
    ['CIV301', 'Structural Analysis'],
    ['CIV302', 'Geotechnical Engineering'],
    ['CIV303', 'Transportation Engineering'],
  ],
};

const FIRST_NAMES = ['Aarav', 'Isha', 'Rohan', 'Sneha', 'Vikram', 'Priya', 'Karthik', 'Ananya', 'Rahul', 'Meera', 'Aditya', 'Neha', 'Siddharth', 'Divya', 'Arjun', 'Kavya', 'Nikhil', 'Pooja', 'Rohit', 'Shreya', 'Vivek', 'Lakshmi', 'Manish', 'Tanvi', 'Harsh', 'Riya', 'Sameer', 'Anjali', 'Yash', 'Deepa'];
const LAST_NAMES = ['Sharma', 'Patil', 'Iyer', 'Nair', 'Reddy', 'Kulkarni', 'Desai', 'Menon', 'Gupta', 'Joshi', 'Rao', 'Bhat', 'Chauhan', 'Verma', 'Shetty', 'Pillai'];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

function phoneFor(seed: number): string {
  const base = 9000000000 + (seed * 137) % 99999999;
  return String(base).slice(0, 10);
}

async function main() {
  console.log('[seed] migrating…');
  await migrate();
  await seedReferenceData();

  await q('DELETE FROM attendance_sessions WHERE is_demo = TRUE');
  await q('DELETE FROM students WHERE is_demo = TRUE');
  await q('DELETE FROM staff WHERE is_demo = TRUE');

  const adminHash = hashPassword('Admin@123');
  const teacherHash = hashPassword('Teacher@123');
  const hodHash = hashPassword('Hod@123');
  const studentHash = hashPassword('Student@123');
  const staffHash = hashPassword('Staff@123');

  await q(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ('Dr. Ramesh Kulkarni','admin@attendease.college','9000000001',$1,'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,
    [adminHash],
  );

  let deptIndex = 0;
  for (const [code, name] of DEPARTMENTS) {
    deptIndex += 1;
    const dept = await one<{ id: number }>(
      `INSERT INTO departments (code, name) VALUES ($1,$2)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [code, name],
    );
    const deptId = Number(dept!.id);

    const hodEmail = `hod.${code.toLowerCase()}@attendease.college`;
    await q(
      `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
       VALUES ($1,$2,$3,$4,'hod',$5) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, department_id=EXCLUDED.department_id`,
      [`Dr. ${pick(LAST_NAMES, deptIndex)} (HOD ${code})`, hodEmail, phoneFor(deptIndex * 11), hodHash, deptId],
    );

    const classes: number[] = [];
    for (const sem of [3, 5]) {
      for (const sec of ['A', 'B']) {
        const cls = await one<{ id: number }>(
          `INSERT INTO classes (name, department_id, semester, section, academic_year)
           VALUES ($1,$2,$3,$4,'2026-27')
           ON CONFLICT (name, department_id, semester, section, academic_year)
           DO UPDATE SET active=TRUE RETURNING id`,
          [`${code} Sem ${sem}`, deptId, sem, sec],
        );
        classes.push(Number(cls!.id));
      }
    }

    const subjects: { id: number; code: string }[] = [];
    for (const [scode, sname] of SUBJECT_POOL[code]) {
      const s = await one<{ id: number }>(
        `INSERT INTO subjects (code, name, department_id, semester, credits)
         VALUES ($1,$2,$3,5,4) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [scode, sname, deptId],
      );
      subjects.push({ id: Number(s!.id), code: scode });
    }

    const teacherEmail = `teacher.${code.toLowerCase()}@attendease.college`;
    const teacherUser = await one<{ id: number }>(
      `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
       VALUES ($1,$2,$3,$4,'teacher',$5) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, department_id=EXCLUDED.department_id RETURNING id`,
      [`Prof. ${pick(FIRST_NAMES, deptIndex)} ${pick(LAST_NAMES, deptIndex + 3)}`, teacherEmail, phoneFor(deptIndex * 17), teacherHash, deptId],
    );
    const teacherId = Number(teacherUser!.id);

    const teachingStaff: number[] = [];
    const demoTeacherStaff = await one<{ id: number }>(
      `INSERT INTO staff (staff_code, full_name, designation, department_id, phone, email, employment_type, is_demo)
       VALUES ($1,$2,'Assistant Professor',$3,$4,$5,'teaching',TRUE)
       ON CONFLICT (staff_code) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`,
      [`${code}-T01`, `Prof. ${pick(FIRST_NAMES, deptIndex)} ${pick(LAST_NAMES, deptIndex + 3)}`, deptId, phoneFor(deptIndex * 17), teacherEmail],
    );
    teachingStaff.push(Number(demoTeacherStaff!.id));

    for (let t = 2; t <= 4; t += 1) {
      const st = await one<{ id: number }>(
        `INSERT INTO staff (staff_code, full_name, designation, department_id, phone, employment_type, is_demo)
         VALUES ($1,$2,$3,$4,$5,'teaching',TRUE)
         ON CONFLICT (staff_code) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`,
        [`${code}-T0${t}`, `Prof. ${pick(FIRST_NAMES, deptIndex + t * 3)} ${pick(LAST_NAMES, deptIndex + t)}`, t === 2 ? 'Associate Professor' : 'Assistant Professor', deptId, phoneFor(deptIndex * 31 + t)],
      );
      teachingStaff.push(Number(st!.id));
    }
    const designations = ['Lab Assistant', 'Office Superintendent', 'Librarian'];
    for (let n = 1; n <= 3; n += 1) {
      await q(
        `INSERT INTO staff (staff_code, full_name, designation, department_id, phone, employment_type, is_demo)
         VALUES ($1,$2,$3,$4,$5,'non_teaching',TRUE)
         ON CONFLICT (staff_code) DO UPDATE SET full_name=EXCLUDED.full_name`,
        [`${code}-N0${n}`, `${pick(FIRST_NAMES, deptIndex + n * 7)} ${pick(LAST_NAMES, deptIndex + n * 2)}`, designations[n - 1], deptId, phoneFor(deptIndex * 47 + n)],
      );
    }

    const staffLoginEmail = `staff.${code.toLowerCase()}@attendease.college`;
    await q(
      `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
       VALUES ($1,$2,$3,$4,'staff',$5) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, department_id=EXCLUDED.department_id`,
      [`${pick(FIRST_NAMES, deptIndex + 5)} ${pick(LAST_NAMES, deptIndex + 9)}`, staffLoginEmail, phoneFor(deptIndex * 53), staffHash, deptId],
    );
    await q(
      `INSERT INTO staff (staff_code, full_name, designation, department_id, phone, email, employment_type, is_demo)
       VALUES ($1,$2,'Lab Assistant',$3,$4,$5,'non_teaching',TRUE)
       ON CONFLICT (staff_code) DO UPDATE SET email=EXCLUDED.email`,
      [`${code}-N09`, `${pick(FIRST_NAMES, deptIndex + 5)} ${pick(LAST_NAMES, deptIndex + 9)}`, deptId, phoneFor(deptIndex * 53), staffLoginEmail],
    );

    for (const classId of classes) {
      for (const sub of subjects.slice(0, 2)) {
        await q(
          `INSERT INTO teacher_assignments (teacher_user_id, department_id, class_id, subject_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT (teacher_user_id, class_id, subject_id) DO NOTHING`,
          [teacherId, deptId, classId, sub.id],
        );
      }
    }

    let sIdx = 0;
    for (const classId of classes) {
      const cls = await one<{ semester: number; section: string }>('SELECT semester, section FROM classes WHERE id=$1', [classId]);
      for (let i = 1; i <= 12; i += 1) {
        sIdx += 1;
        const roll = `${code}${cls!.semester}${cls!.section}${String(i).padStart(2, '0')}`;
        const name = `${pick(FIRST_NAMES, sIdx)} ${pick(LAST_NAMES, sIdx + deptIndex)}`;
        const guardianPhone = phoneFor(sIdx * 3 + deptIndex);
        const student = await one<{ id: number }>(
          `INSERT INTO students (roll_no, full_name, email, phone, department_id, class_id, semester, section,
                                 guardian_name, guardian_phone, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
           ON CONFLICT (roll_no) DO UPDATE SET full_name=EXCLUDED.full_name, guardian_phone=EXCLUDED.guardian_phone RETURNING id`,
          [
            roll,
            name,
            `student.${roll.toLowerCase()}@attendease.college`,
            phoneFor(sIdx * 5 + 1),
            deptId,
            classId,
            cls!.semester,
            cls!.section,
            `${pick(FIRST_NAMES, sIdx + 9)} ${pick(LAST_NAMES, sIdx + 4)}`,
            guardianPhone,
          ],
        );
        await q('DELETE FROM parent_contacts WHERE student_id=$1', [student!.id]);
        await q('INSERT INTO parent_contacts (student_id, name, relation, phone, consent_given, is_primary) VALUES ($1,$2,$3,$4,TRUE,TRUE)', [
          student!.id,
          `${pick(FIRST_NAMES, sIdx + 9)} ${pick(LAST_NAMES, sIdx + 4)}`,
          'Parent',
          guardianPhone,
        ]);
      }
    }
    if (code === 'CS') {
      await q(
        `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
         VALUES ('Aarav Sharma','student@attendease.college','9000000777',$1,'student',$2)
         ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, department_id=EXCLUDED.department_id`,
        [studentHash, deptId],
      );
      const target = await one<{ id: number; roll_no: string; full_name: string }>(
        'SELECT id, roll_no, full_name FROM students WHERE department_id=$1 AND class_id=$2 ORDER BY roll_no LIMIT 1',
        [deptId, classes[0]],
      );
      if (target) {
        await q('UPDATE students SET email=$2::text WHERE id=$1::int', [target.id, 'student@attendease.college']);
        await q('UPDATE users SET full_name=$1::text WHERE email=$2::text', [target.full_name, 'student@attendease.college']);
      }
    }
  }

  console.log('[seed] reference + master data done');

  const days: string[] = [];
  const cursor = new Date(`${todayISO()}T00:00:00Z`);
  while (days.length < 15) {
    const dow = cursor.getUTCDay();
    if (dow !== 0) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let sessions = 0;
  let records = 0;
  const classes = await q<{ id: number; department_id: number }>('SELECT id, department_id FROM classes ORDER BY id');
  for (const cls of classes) {
    const subs = await q<{ id: number }>('SELECT id FROM subjects WHERE department_id=$1 ORDER BY id LIMIT 2', [cls.department_id]);
    const students = await q<{ id: number }>('SELECT id FROM students WHERE class_id=$1 ORDER BY roll_no', [cls.id]);
    const teacher = await one<{ teacher_user_id: number }>('SELECT teacher_user_id FROM teacher_assignments WHERE class_id=$1 LIMIT 1', [cls.id]);
    if (!subs.length || !students.length || !teacher) continue;
    for (let di = 0; di < days.length; di += 1) {
      const day = days[di];
      const sub = subs[di % subs.length];
      const period = 1 + (di % 3);
      const session = await one<{ id: number }>(
        `INSERT INTO attendance_sessions (kind, department_id, class_id, subject_id, period_no, session_date,
                                          taken_by_user_id, status, is_demo, submitted_at)
         VALUES ('student',$1,$2,$3,$4,$5,$6,'submitted',TRUE, now())
         ON CONFLICT DO NOTHING RETURNING id`,
        [cls.department_id, cls.id, sub.id, period, day, teacher.teacher_user_id],
      );
      if (!session) continue;
      sessions += 1;
      for (let si = 0; si < students.length; si += 1) {
        const roll = (si * 7 + di * 3 + cls.id) % 100;
        const status = roll < 82 ? 'present' : roll < 94 ? 'absent' : 'leave';
        await q(
          `INSERT INTO student_attendance (session_id, student_id, status, marked_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (session_id, student_id) DO NOTHING`,
          [session.id, students[si].id, status, teacher.teacher_user_id],
        );
        records += 1;
      }
    }
  }

  const allDepts = await q<{ id: number; code: string }>('SELECT id, code FROM departments ORDER BY id');
  const admin = await one<{ id: number }>("SELECT id FROM users WHERE role='admin' LIMIT 1");
  let staffRecords = 0;
  for (const d of allDepts) {
    const staff = await q<{ id: number }>('SELECT id FROM staff WHERE department_id=$1 ORDER BY id', [d.id]);
    for (let di = 0; di < days.length; di += 1) {
      const s = await one<{ id: number }>(
        `INSERT INTO attendance_sessions (kind, department_id, period_no, session_date, taken_by_user_id, status, is_demo, submitted_at)
         VALUES ('staff',$1,1,$2,$3,'submitted',TRUE, now()) ON CONFLICT DO NOTHING RETURNING id`,
        [d.id, days[di], admin!.id],
      );
      if (!s) continue;
      for (let si = 0; si < staff.length; si += 1) {
        const r = (si * 5 + di * 2) % 100;
        const status = r < 88 ? 'present' : r < 94 ? 'absent' : r < 97 ? 'leave' : 'half_day';
        await q('INSERT INTO staff_attendance (session_id, staff_id, status, marked_by) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id, staff_id, marked_by) DO NOTHING', [
          s.id,
          staff[si].id,
          status,
          admin!.id,
        ]);
        staffRecords += 1;
      }
    }
  }

  console.log(`[seed] demo attendance: ${sessions} student sessions, ${records} student records, ${staffRecords} staff records`);
  console.log('[seed] logins: admin@attendease.college / Admin@123, teacher.cs@… / Teacher@123, hod.cs@… / Hod@123, student@attendease.college / Student@123');
  await closeDb();
}

if (process.argv[1]?.includes('seed')) {
  main().catch(async (err) => {
    console.error('[seed] failed', err);
    await closeDb();
    process.exit(1);
  });
}

export { main };   