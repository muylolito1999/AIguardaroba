// Signed-out pages get no sidebar or tab bar: their links would only bounce
// back to /login. The safe-area padding matches the (app) layout, because
// viewport-fit=cover lets the installed app draw under the notch here too.
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main
      id="main"
      className="flex min-h-svh flex-col items-center justify-center px-4 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
    >
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}
