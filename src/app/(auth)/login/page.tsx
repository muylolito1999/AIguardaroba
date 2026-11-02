import type { Metadata } from "next"
import { Shirt } from "lucide-react"

import { LoginForm } from "@/components/auth/login-form"
import { Card, CardContent } from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Sign in",
}

// Fully static, with no request data read on the server (D-054). A login form
// posted without JavaScript gets the re-rendered page back as the response;
// on a partially prerendered route Next 16.4.3 answers such a post with only
// the dynamic part, which leaves a blank page.
export default function LoginPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Shirt className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Wardrobe</h1>
          <p className="text-sm text-muted-foreground">Enter your password to sign in.</p>
        </div>
      </div>
      <Card>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </div>
  )
}
