package build.hands.update

import android.app.ActivityManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Process

/** Isolated process: exiting it leaves a real, inspectable process-summary record. */
class AnrStampProbeService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (intent?.getBooleanExtra(EXTRA_OPT_OUT, false) == true) {
                getSystemService(ActivityManager::class.java)
                    .setProcessStateSummary(OTHER_SUMMARY.toByteArray(Charsets.UTF_8))
                HandsCrash.setAnrBuildStampingEnabled(false)
            }
            HandsCrash.stampAnrBuild(this)
        }
        // Avoid Android redelivering the prior intent into the next test.
        stopSelf(startId)
        Process.killProcess(Process.myPid())
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val EXTRA_OPT_OUT = "opt_out"
        const val OTHER_SUMMARY = "host-owned-process-summary"
    }
}
