/** The customer's own skeleton; without one they inherit the dashboard's. */
export default function Loading() {
  return (
    <main className="min-h-screen animate-pulse bg-gray-50 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 h-8 w-56 rounded bg-gray-200" />
        <div className="mb-5 h-24 rounded-xl bg-white" />
        <div className="mb-5 h-44 rounded-xl bg-white" />
        <div className="h-32 rounded-xl bg-white" />
      </div>
    </main>
  )
}
