# Deployment Checklist

## 1. Firebase Setup
- [ ] Create a Firebase Project (Free Tier "Spark").
- [ ] **Authentication**: Enable "Email/Password" provider.
- [ ] **Firestore**: Create Database (Production Mode).
- [ ] **Rules**: Copy the contents of `firestore.rules` to the Firestore Rules tab.
- [ ] **Indexes**: If sorting issues occur, click the generated link in console logs to create indexes. Default queries should work.
- [ ] **Users**: Manually create users in Firebase Console > Firestore > `users` collection:
    - Document ID: `UID` (Copy from Authentication tab after creating user).
    - Field: `role`, Value: `"employee"` or `"admin"`.
    - Field: `name`, Value: "John Doe".

## 2. Vercel Deployment
- [ ] Import project from GitHub.
- [ ] **Environment Variables**: Add all variables from `.env.example`.
    - Careful with `FIREBASE_PRIVATE_KEY`: Copy the whole string including `-----BEGIN...`.
- [ ] Deploy.

## 3. Configuration
- [ ] Set `NEXT_PUBLIC_OFFICE_LAT` and `NEXT_PUBLIC_OFFICE_LNG` to your exact office coordinates (Google Maps).

## 4. Testing
- [ ] Create a test user in Auth & Firestore (Role: Employee).
- [ ] Login on mobile/desktop.
- [ ] Allow location permissions.
- [ ] Try Punch In (Must be within 100m of configured Lot/Lat).
- [ ] Check Firestore `attendance` collection for new record.
