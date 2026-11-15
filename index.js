import { createClient } from '@supabase/supabase-js'
 const supabase = createClient(
'https://eyofwxqhtpqtsvypaqrk.supabase.co',
 'sb_publishable_Ydi64uLp2vjtwpG2OHUdkA_tdu5DdJy'
 )
// Sign in
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'prkshsalyan@gmail.com',      // ← the email you used
  password: 'AyusXaminn7'        // ← the password you set
})

if (error) {
  console.error('Sign in failed:', error.message)
  process.exit(1)
}

// Build session URL
const session = data.session
const hash = [
  `access_token=${encodeURIComponent(session.access_token)}`,
  `expires_in=${encodeURIComponent(session.expires_in)}`,
  `refresh_token=${encodeURIComponent(session.refresh_token)}`,
  `token_type=${encodeURIComponent(session.token_type)}`
].join('&')

const sessionUrl = `https://your-app.com/#${hash}`
console.log('Session URL:', sessionUrl)