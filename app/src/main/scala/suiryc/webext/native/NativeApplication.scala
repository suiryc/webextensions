package suiryc.webext.native

object NativeApplication extends Logger {

  def main(args: Array[String]): Unit = {
    info("Starting")
    NativeMessagingHandler.handleIncoming(receivedMessage)
    info("Ready to receive messages")
  }

  /** Terminates application. */
  def terminate(code: Int): Unit = {
    // For now, we only have to exit the process
    info("Done")
    NativeMessagingHandler.done(code)
  }

  /** Handles incoming message. */
  private def receivedMessage(msg: ApplicationMessage): Unit = {
    try {
      msg.feature match {
        case WebExtensionMessage.Feature.tiddlywiki =>
          tw_receivedMessage(msg)

        case _ =>
          unhandled(msg)
      }
    } catch {
      case ex: Exception =>
        error(s"Failed to process message: ${ex.getMessage}", ex)
    }
  }

  private def unhandled(msg: ApplicationMessage): Unit = {
    warning(s"Received unhandled message feature=<${msg.feature}> kind=<${msg.kind}> contentSize=${msg.content.map(_.length).getOrElse(0)}")
  }

  private def tw_receivedMessage(msg: ApplicationMessage): Unit = {
    msg.kind match {
      case WebExtensionMessage.Kind.save =>
        tw_save(msg)

      case _ =>
        unhandled(msg)
    }
  }

  private def tw_save(msg: ApplicationMessage): Unit = {
    import scala.scalajs.js
    import js.Dynamic.{global => g}
    import js.DynamicImplicits._

    val fs = g.require("fs")
    fs.writeFile("D:\\test.html", "Hey there!", { (err: js.Dynamic) =>
      val response = if (err) {
        ApplicationMessage(
          feature = msg.feature,
          kind = WebExtensionMessage.Kind.response,
          error = Some("Not implemented"),
          correlationId = msg.correlationId
        )
      } else {
        ApplicationMessage(
          feature = msg.feature,
          kind = WebExtensionMessage.Kind.response,
          error = Some("Not implemented"),
          correlationId = msg.correlationId
        )
      }
      NativeMessagingHandler.postMessage(response)
    })
    ()
  }

}
