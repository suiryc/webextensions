package suiryc.webext.native

import io.circe.Printer
import io.circe.generic.auto._
import io.circe.syntax._
import io.scalajs.nodejs.process
import io.scalajs.nodejs.buffer.Buffer
import io.scalajs.npm.readablestream.Readable
import java.io.ByteArrayOutputStream
import java.nio.{ByteBuffer, ByteOrder}
import java.nio.charset.StandardCharsets
import java.util.UUID
import scala.concurrent.duration._

/** Handles native messaging (read/write). */
object NativeMessagingHandler extends Logger {

  /** Exits process. */
  def done(code: Int): Unit = {
    process.exit(code)
  }

  /** Uses callback function to handle incoming messages. */
  def handleIncoming(handler: ApplicationMessage => Unit): Unit = {
    // We receive raw messages from stdin:
    //  - uint32 (native order): message size
    //  - UTF-8 JSON message

    // Once EOS is reached, it is time to stop.
    process.stdin.onEnd { () =>
      NativeApplication.terminate(0)
    }

    // Process RAW data as it arrives.
    // Process is as follow:
    //  - until incoming message size is fully received and parsed, readSize is negative
    //  - until incoming message is fully received and parsed, readSize is positive
    process.stdin.onData { b =>
      // Beware: 'b.values' iterator has quirks, like advancing when 'hasNext'
      // is called. So simply call 'next' and check whether the returned value
      // marks the iterator end (entry.done).
      val it = b.values

      @scala.annotation.tailrec
      def loop(): Unit = {
        val e = it.next
        if (!e.done) {
          // One more byte
          if (readSize < 0) {
            // Message size not yet received
            readSizeBBuffer.put(e.value.toByte)
            if (readSizeBBuffer.position == UINT32_SIZE) {
              // Message size received, decode it
              readSizeBBuffer.clear()
              // Size is an unsigned integer (0 to 2^32-1), while we handle signed values.
              // We could convert the read value to a Long (size & 0x00000000ffffffffL) to
              // hold big values, but anyway we cannot use a long to handle arrays or
              // read a stream.
              readSize = readSizeBBuffer.getInt
              if (readSize < 0) {
                error(s"Message too big: size=<${readSize & 0x00000000ffffffffL}>")
                process.exit(1)
              }
              // Don't forget to clear the buffer (for the next message)
              readSizeBBuffer.clear()
            }
          } else {
            // Message not yet received
            readContentStream.write(e.value)
            readSize -= 1
            if (readSize == 0) {
              // Message received, decode it
              readSize = -1
              val json = new String(readContentStream.toByteArray, "UTF-8")
              // Don't forget to clear the buffer (for the next message)
              readContentStream.reset()
              decodeMessage(json).foreach(handler)
            }
          }
          loop()
        }
      }
      loop()
      fragmentsJanitoring()
    }

    ()
  }

  /** Posts message to WebExtension. */
  def postMessage(msg: WebExtensionMessage, noSplit: Boolean = false): Unit = {
    // Don't 'debug' if we push logs through native messaging
    //debug(s"Write message=<$msg>")
    // Formatting a trait should result in an object which unique key is the
    // class short name and value its content. Get to the content when
    // applicable.
    val json = try {
      val jsonObj = msg.asJsonObject
      if (jsonObj.size == 1) {
        // One key, get to the actual content.
        jsonObj.values.head
      } else {
        // Not one key, already got the content.
        msg.asJson
      }
    } catch {
      case ex: Exception =>
        LogMessage(
          WebExtensionMessage.Feature.app,
          LogMessage.Level.ERROR,
          s"Failed to encode message: ${ex.getMessage}"
        ).asJson
    }

    val jsonString = jsonPrinter.pretty(json)
    val content = jsonString.getBytes(StandardCharsets.UTF_8)
    if (noSplit || (content.length < MSG_SPLIT_SIZE)) {
      postMessage(content)
    } else {
      postFragments(msg, jsonString.grouped(MSG_SPLIT_SIZE))
    }
  }

  private def postFragments(msg: WebExtensionMessage, fragments: Iterator[String]): Unit = {
    val correlationId = UUID.randomUUID.toString
    val msgFragment = ApplicationMessage(
      feature = msg.feature,
      kind = msg.kind,
      content = Some(fragments.next),
      fragment = Some(WebExtensionMessage.FragmentKind.start),
      correlationId = Some(correlationId)
    )

    @scala.annotation.tailrec
    def loop(): Unit = {
      val content = fragments.next
      if (fragments.hasNext) {
        postMessage(msgFragment.copy(
          content = Some(content),
          fragment = Some(WebExtensionMessage.FragmentKind.cont)
        ), noSplit = true)
        loop()
      } else {
        postMessage(msgFragment.copy(
          content = Some(content),
          fragment = Some(WebExtensionMessage.FragmentKind.end)
        ), noSplit = true)
      }
    }
    postMessage(msgFragment, noSplit = true)
    loop()
  }

  private def postMessage(content: Array[Byte]): Unit = {
    writeSizeBBuffer.clear()
    writeSizeBBuffer.putInt(content.length)

    // We need to write binary data to process.stdout through the
    // readable-stream API.
    // Create a Readable we will be able to write to stdout.
    val bulk = new Readable()
    // First queue the uint32 message size.
    val arr1 = new scalajs.js.Array[Int]()
    arr1.push(writeSizeBuffer.map(_.toInt):_*)
    bulk.push(Buffer.from(arr1))
    // Then queue the UTF-8 JSON message.
    val arr2 = new scalajs.js.Array[Int]()
    arr2.push(content.map(_.toInt):_*)
    bulk.push(Buffer.from(arr2))
    // This is the end of the data to write.
    bulk.push(null)
    // Write the data.
    bulk.pipe(process.stdout)
  }

  /**
   * Split size.
   * Mas message size is supposed to be 1MB. But Trying to send a 128KiB
   * message makes the application disconnect (at least with FireFox).
   */
  private val MSG_SPLIT_SIZE = 64 * 1024

  /** UINT32 size in bytes. */
  private val UINT32_SIZE = 4
  /** Current incoming message size. -1 if size not yet parsed. */
  private var readSize = -1
  /** Incoming message size raw buffer. */
  private val readSizeBuffer = new Array[Byte](UINT32_SIZE)
  /** Incoming message size ByteBuffer. */
  private val readSizeBBuffer = ByteBuffer.wrap(readSizeBuffer).order(ByteOrder.nativeOrder)
  /** Incoming message buffer. */
  private val readContentStream = new ByteArrayOutputStream()
  /** Outgoing message size raw buffer. */
  private val writeSizeBuffer = new Array[Byte](UINT32_SIZE)
  /** Outgoing message size ByteBuffer. */
  private val writeSizeBBuffer = ByteBuffer.wrap(writeSizeBuffer).order(ByteOrder.nativeOrder)

  /** JSON printer. */
  private val jsonPrinter = Printer.noSpaces.copy(dropNullValues = true)

  /** Incoming messages fragments. */
  private var fragments: Map[String, ApplicationMessage] = Map.empty
  /** Last fragments janitoring mark. */
  private var fragmentsLastJanitoring = System.currentTimeMillis
  /** Fragments TTL. */
  private val FRAGMENTS_TTL = 60.seconds
  /** Fragments janitoring period. */
  private val FRAGMENTS_JANITORING_PERIOD = 30.seconds

  private def decodeMessage(json: String): Option[ApplicationMessage] = {
    import io.circe.generic.auto._
    import io.circe.parser._

    decode[ApplicationMessage](json) match {
      case Left(ex) =>
        error(s"Failed to read message: ${ex.getMessage}", ex)
        None

      case Right(msg0) =>
        if (msg0.fragment.isDefined) {
          addFragment(msg0)
        } else {
          Some(msg0)
        }
    }
  }

  /** Handle new fragment. */
  private def addFragment(msg: ApplicationMessage): Option[ApplicationMessage] = {
    assert(msg.fragment.isDefined)
    val fragmentKind = msg.fragment.get

    msg.correlationId match {
      case Some(correlationId) =>
        fragments.get(correlationId) match {
          case Some(previousFragment) =>
            if (fragmentKind == WebExtensionMessage.FragmentKind.start) {
              warning(s"Dropping incomplete message feature=<${msg.feature}> kind=<${msg.kind}> correlationId=<${msg.correlationId.get}>: received new fragment start")
              fragments += (correlationId -> msg)
              None
            } else {
              val newFragment = previousFragment.copy(
                content = Some(previousFragment.content.getOrElse("") + msg.content.getOrElse("")),
                fragment = None
              )
              if (fragmentKind == WebExtensionMessage.FragmentKind.cont) {
                fragments += (correlationId -> newFragment)
                None
              } else {
                fragments -= correlationId
                decodeMessage(newFragment.content.getOrElse(""))
              }
            }

          case None =>
            if (fragmentKind == WebExtensionMessage.FragmentKind.start) {
              fragments += (correlationId -> msg)
            } else {
              warning(s"Dropping message feature=<${msg.feature}> kind=<${msg.kind}> correlationId=<$correlationId> fragment=<$fragmentKind>: missing fragment start")
            }
            None
        }

      case None =>
        error(s"Dropping message feature=<${msg.feature}> kind=<${msg.kind}> fragment=<$fragmentKind>: missing correlationId")
        None
    }
  }

  /** Janitors fragments. */
  private def fragmentsJanitoring(): Unit = {
    if (System.currentTimeMillis - fragmentsLastJanitoring > FRAGMENTS_JANITORING_PERIOD.toMillis) {
      fragments.foreach {
        case (correlationId, msg) =>
          if (System.currentTimeMillis - msg.msgCreationTime > FRAGMENTS_TTL.toMillis) {
            warning(s"Dropping incomplete message feature=<${msg.feature}> kind=<${msg.kind}> correlationId=<$correlationId>: TTL reached")
            fragments -= correlationId
          }
      }
      fragmentsLastJanitoring = System.currentTimeMillis
    }
  }

}
