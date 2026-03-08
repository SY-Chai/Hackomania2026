import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-4xl font-bold tracking-tight text-slate-900">
          PABand
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Personal Alert Button assistant dashboard and caller interface
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <Link
            href="/button"
            className="inline-flex h-11 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-500"
          >
            Open Button
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
            Open Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
