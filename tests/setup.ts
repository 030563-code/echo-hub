// Global test setup. Ensures a HubSpot token is present so the client wrapper
// doesn't throw its config error during unit tests (network is always mocked).
process.env.HUBSPOT_ACCESS_TOKEN ||= 'test-token'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service'
