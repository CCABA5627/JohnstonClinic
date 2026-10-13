# Push Notification Setup — One-Time Steps

Do these once, then push notifications will work forever.

---

## Step 1 — Generate VAPID Keys

On any computer that has Node.js installed, run:

```bash
npx web-push generate-vapid-keys
```

It will print something like:
```
Public Key:  BNx8G1q...
Private Key: 7Kd9P2m...
```

Copy both values. You'll need them in the next two steps.

---

## Step 2 — Add Secrets to Supabase

1. Go to https://supabase.com → your project → **Project Settings** → **Edge Functions**
2. Click **"Add new secret"** and add all three:

| Name | Value |
|------|-------|
| `VAPID_PUBLIC_KEY` | (your public key from Step 1) |
| `VAPID_PRIVATE_KEY` | (your private key from Step 1) |
| `VAPID_SUBJECT` | `mailto:your-email@example.com` |

---

## Step 3 — Create the push_subscriptions Table

In Supabase → **SQL Editor**, run this:

```sql
create table if not exists push_subscriptions (
  id uuid default gen_random_uuid() primary key,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);

-- Allow the portal to insert subscriptions
alter table push_subscriptions enable row level security;
create policy "Anyone can subscribe" on push_subscriptions
  for insert with check (true);
create policy "Service role can read/delete" on push_subscriptions
  for all using (auth.role() = 'service_role');
```

---

## Step 4 — Deploy the Edge Function

Install the Supabase CLI (if you don't have it):
```bash
npm install -g supabase
```

From the `johnstonclinic` folder:
```bash
supabase login
supabase link --project-ref ziyuuprfoozzlcdtxhlt
supabase functions deploy notify-staff
```

---

## Step 5 — Add Your VAPID Public Key to index.html

In `index.html`, find this line near the bottom:
```js
const VAPID_PUBLIC_KEY = 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY';
```

Replace it with your actual public key from Step 1.

---

## Step 6 — Staff Install Instructions (share with your team)

For push notifications to work on iPhone:

1. Open the staff portal link in **Safari**
2. Tap the **Share** button (box with arrow)
3. Tap **"Add to Home Screen"**
4. Open the app from the home screen
5. Tap **"Enable Notifications"** when the banner appears
6. Tap **"Allow"**

Done — they'll get a notification any time you push the schedule.

---

## How It Works After Setup

- Scheduler clicks "📤 Push to Staff Portal"
- Assignments save to Supabase
- The `notify-staff` Edge Function sends a push to every subscribed device
- Staff see a notification appear on their phone, even if the app is closed
- Tapping the notification opens the staff portal
