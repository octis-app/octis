import { SignIn } from '@clerk/clerk-react'

export default function AuthGate() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#0f1117]">
      <div className="flex flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2 mb-2">
          <span className="text-4xl">🐙</span>
          <h1 className="text-2xl font-bold text-white tracking-tight">Octis</h1>
          <p className="text-sm text-[#6b7280]">AI command center</p>
        </div>
        <SignIn
          appearance={{
            elements: {
              rootBox: 'w-full',
              card: 'bg-[#181c24] border border-[#2a3142] shadow-2xl rounded-2xl',
              headerTitle: 'text-white',
              headerSubtitle: 'text-[#9ca3af]',
              socialButtonsBlockButton: 'bg-[#1e2330] border-[#2a3142] text-white hover:bg-[#2a3142]',
              dividerLine: 'bg-[#2a3142]',
              dividerText: 'text-[#6b7280]',
              formFieldLabel: 'text-[#9ca3af]',
              formFieldInput: 'bg-[#0f1117] border-[#2a3142] text-white focus:border-[#6366f1]',
              formButtonPrimary: 'bg-[#6366f1] hover:bg-[#818cf8] text-white',
              footerActionLink: 'text-[#6366f1] hover:text-[#818cf8]',
              identityPreviewEditButton: 'text-[#6366f1]',
            },
          }}
        />
      </div>
    </div>
  )
}
