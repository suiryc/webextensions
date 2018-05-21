package suiryc.webext.native

import java.io.{ByteArrayOutputStream, PrintStream}

class Logger(feature: WebExtensionMessage.Feature.Value = WebExtensionMessage.Feature.app) {

  def log(level: LogMessage.Level.Value, msg: String): Unit = {
    NativeMessagingHandler.postMessage(LogMessage(feature, level, msg))
  }

  def debug(msg: String): Unit = {
    log(LogMessage.Level.DEBUG, msg)
  }

  def info(msg: String): Unit = {
    log(LogMessage.Level.INFO, msg)
  }

  def notice(msg: String): Unit = {
    log(LogMessage.Level.NOTICE, msg)
  }

  def warning(msg: String): Unit = {
    log(LogMessage.Level.WARNING, msg)
  }

  def error(msg: String): Unit = {
    log(LogMessage.Level.ERROR, msg)
  }

  def error(msg: String, ex: Throwable): Unit = {
    val baos = new ByteArrayOutputStream()
    val out = new PrintStream(baos, false, "UTF-8")
    ex.printStackTrace(out)
    out.flush()
    out.close()
    val st = baos.toString("UTF-8")
    log(LogMessage.Level.ERROR, s"$msg\n$st")
  }

}
